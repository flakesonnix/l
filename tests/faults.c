#include "../bootstrap/stage0/l.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "source.h"

/* Linker interposition exercises real error handling without production hooks. */
void *__real_calloc(size_t, size_t);
size_t __real_fread(void *, size_t, size_t, FILE *);
int __real_ferror(FILE *);
int __real_fclose(FILE *);
int __real_stat(const char *, struct stat *);
static bool fail_allocation;
static int fail_read;
static bool fail_close;
static unsigned close_skip;
static const char *fail_stat_path;
static int fail_stat_error;
static FILE *io_stream;

void *__wrap_calloc(size_t count, size_t size) {
    if (fail_allocation) { fail_allocation = false; return NULL; }
    return __real_calloc(count, size);
}
size_t __wrap_fread(void *data, size_t size, size_t count, FILE *file) {
    if (fail_read == 1) { fail_read = 2; return 0; }
    if (fail_read == 3) { fail_read = 0; return 0; }
    return __real_fread(data, size, count, file);
}
int __wrap_ferror(FILE *file) {
    if (fail_read == 2) { fail_read = 0; return 1; }
    return __real_ferror(file);
}
int __wrap_fclose(FILE *file) {
    int result = __real_fclose(file);
    if (fail_close && close_skip) --close_skip;
    else if (fail_close) { fail_close = false; return EOF; }
    return result;
}
int __wrap_stat(const char *path, struct stat *info) {
    if (fail_stat_path && !strcmp(path, fail_stat_path)) {
        fail_stat_path = NULL; errno = fail_stat_error; return -1;
    }
    return __real_stat(path, info);
}

static Ast *frontend(Context *ctx, const char *source) {
    source = test_source(ctx, source);
    size_t count;
    Token *tokens = lex(ctx, source, strlen(source), &count);
    return parse(ctx, tokens, count);
}
static void memory_one(Context *ctx) { (void)allocate(ctx, 128u * 1024u * 1024u + 1); }
static void memory_total(Context *ctx) { ctx->allocated = 128u * 1024u * 1024u; (void)allocate(ctx, 1); }
static void memory_system(Context *ctx) { fail_allocation = true; (void)allocate(ctx, 1); }
static void vector_growth(Context *ctx) {
    void *data = NULL; size_t capacity = 0;
    reserve(ctx, &data, &capacity, 100, 1);
    if (capacity < 100) exit(1);
}
static void vector_overflow(Context *ctx) {
    void *data = NULL; size_t capacity = 0;
    reserve(ctx, &data, &capacity, SIZE_MAX, 1);
}
static void vector_element_overflow(Context *ctx) {
    void *data = NULL; size_t capacity = 0;
    reserve(ctx, &data, &capacity, 1, SIZE_MAX);
}
static void missing_filename(Context *ctx) { ctx->filename = NULL; fail(ctx, 0, 0, "test diagnostic"); }
static void type_names(Context *ctx) {
    (void)ctx;
    if (strcmp(type_name(TY_AUTO), "auto") || strcmp(type_name(TY_NAMED), "unresolved type") ||
        strcmp(type_name(TY_STRUCT), "struct") || strcmp(type_name((Type)(TY_STRUCT + 1)), "struct") ||
        strcmp(type_name(TY_ENUM), "enum") || strcmp(type_name((Type)(TY_ENUM + 1)), "enum") ||
        strcmp(type_name(TY_BYTE), "byte") || strcmp(type_name(TY_STRING), "string") || strcmp(type_name((Type)UINT32_MAX), "invalid")) exit(1);
}
static void syntax_depth(Context *ctx) { ctx->nesting = L_MAX_DEPTH; enter(ctx, (Token){0}); }
static void nul_source(Context *ctx) { size_t count; (void)lex(ctx, "\0", 1, &count); }
static void nul_block(Context *ctx) { size_t count; (void)lex(ctx, "/*\0*/", 5, &count); }
static void nul_line(Context *ctx) { size_t count; (void)lex(ctx, "//\0\n", 4, &count); }
static void lex_edges(Context *ctx) {
    size_t count;
    (void)lex(ctx, "name9_", 6, &count);
    (void)lex(ctx, "/", 1, &count);
    (void)lex(ctx, "//", 2, &count);
}
static void path_edges(Context *ctx) {
    if (strcmp(relative_path(ctx, "/", "abc"), "/abc") || strcmp(relative_path(ctx, "", "abc"), "abc") ||
        strcmp(source_directory(ctx, "/package.json"), "/")) exit(1);
}
static void canonical_memory(Context *ctx) {
    fail_allocation = true;
    (void)canonical_path(ctx, "examples/package.json");
}
static void read_failure(Context *ctx) {
    size_t length;
    fail_read = 1;
    (void)read_file(ctx, "examples/answer.l", &length);
}
static void read_zero(Context *ctx) {
    size_t length;
    fail_read = 3;
    (void)read_file(ctx, "examples/answer.l", &length);
}
static void read_growth(Context *ctx) {
    FILE *file = fopen("build/fault-input", "wb");
    if (!file) exit(1);
    for (unsigned i = 0; i < 9000; ++i) fputc(' ', file);
    fclose(file);
    size_t length;
    (void)read_file(ctx, "build/fault-input", &length);
    if (length != 9000) exit(1);
}
static void read_limit(Context *ctx) {
    FILE *file = fopen("build/fault-input", "wb");
    if (!file) exit(1);
    if (fseek(file, 16L * 1024 * 1024, SEEK_SET)) exit(1);
    fputc(' ', file); fclose(file);
    size_t length;
    (void)read_file(ctx, "build/fault-input", &length);
}
static void close_failure(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){return 0;}"); analyze(ctx, ast);
    Program *p = lower(ctx, ast);
    fail_close = true;
    write_bytecode(ctx, p, "build/fault-output.lbc");
}
static size_t input_length, returned_length;
static void input_close_failure(Context *ctx) {
    fail_close = true;
    (void)read_file(ctx, "build/fault-input", &returned_length);
}
static void input_close_recovery(Context *ctx) {
    size_t length;
    unsigned char *bytes = read_file(ctx, "build/fault-input", &length);
    if (length != input_length || bytes[length]) exit(1);
    for (size_t n = 0; n < length; ++n) if (bytes[n] != (unsigned char)n) exit(1);
}
static void read_failure_close(Context *ctx) { fail_close = true; read_failure(ctx); }
static void read_zero_close(Context *ctx) { fail_close = true; read_zero(ctx); }
static void read_limit_close(Context *ctx) { fail_close = true; close_skip = 1; read_limit(ctx); }

static void put_file(const char *path, const char *text) {
    FILE *file = fopen(path, "wb");
    if (!file || fputs(text, file) == EOF || fclose(file)) exit(1);
}
static void same_file(Context *ctx, const char *path, const void *expected, size_t size) {
    size_t length;
    unsigned char *bytes = read_file(ctx, path, &length);
    if (length != size || memcmp(bytes, expected, size)) exit(1);
    release(ctx, bytes);
}
static void input_close_lifecycle(Context *ctx) {
    const char *source = "module fault.fault_main;import fault.fault_dep as dep;int main(){return dep::answer();}";
    const char *dependency = "module fault.fault_dep;pub int answer(){return 42;}";
    const char *manifest = "{\"version\":1,\"package\":\"fault\",\"module_roots\":["
        "{\"package\":\"fault\",\"prefix\":\"fault\",\"path\":\".\"}],\"dependencies\":[]}";
    put_file("build/fault_main.l", source); put_file("build/fault_dep.l", dependency);
    put_file("build/fault-package.json", manifest);
    char *compile[] = {"l", "compile", "build/fault_main.l", "--manifest", "build/fault-package.json", "-o", "build/fault-close.lbc", NULL};
    if (l_main(7, compile)) exit(1);
    size_t original_length;
    unsigned char *original = read_file(ctx, "build/fault-close.lbc", &original_length);
    unsigned commands = 0;
    for (unsigned operation = 0; operation < 4; ++operation) {
        char *args[] = {"l", "check", "build/fault_main.l", "--manifest", "build/fault-package.json", "-o", "build/fault-output.lbc", NULL};
        const char *operations[] = {"check", "run", "inspect", "compile"};
        args[1] = (char *)operations[operation];
        for (unsigned input = 0; input < 3; ++input) {
            put_file("build/fault-output.lbc", "unchanged");
            fail_close = true; close_skip = input; /* Entry source, manifest, then imported source. */
            if (l_main(operation == 3 ? 7 : 5, args) != 74 || fail_close || close_skip) exit(1);
            same_file(ctx, "build/fault-output.lbc", "unchanged", 9);
            same_file(ctx, "build/fault_main.l", source, strlen(source));
            same_file(ctx, "build/fault_dep.l", dependency, strlen(dependency));
            same_file(ctx, "build/fault-package.json", manifest, strlen(manifest));
            same_file(ctx, "build/fault-close.lbc", original, original_length);
            if (l_main(operation == 3 ? 7 : 5, args) != (operation == 1 ? 42 : 0)) exit(1);
            if (operation == 3) same_file(ctx, "build/fault-output.lbc", original, original_length);
            commands += 2;
        }
    }
    for (unsigned operation = 0; operation < 3; ++operation) {
        char *args[] = {"l", "check", "build/fault-close.lbc", NULL};
        const char *operations[] = {"check", "run", "inspect"};
        args[1] = (char *)operations[operation];
        fail_close = true;
        if (l_main(3, args) != 74 || fail_close) exit(1);
        same_file(ctx, "build/fault-close.lbc", original, original_length);
        if (l_main(3, args) != (operation == 1 ? 42 : 0)) exit(1);
        commands += 2;
    }
    /* A close failure precedes parsing; the same malformed contents still reject on retry. */
    for (unsigned input = 0; input < 4; ++input) {
        const char *paths[] = {"build/fault_main.l", "build/fault-package.json", "build/fault_dep.l", "build/fault-invalid.lbc"};
        const char *contents[] = {source, manifest, dependency, "invalid"};
        char *args[] = {"l", "check", "build/fault_main.l", "--manifest", "build/fault-package.json", NULL};
        if (input == 3) args[2] = "build/fault-invalid.lbc";
        put_file(paths[input], "invalid");
        fail_close = true; close_skip = input == 3 ? 0 : input;
        if (l_main(input == 3 ? 3 : 5, args) != 74 || fail_close || close_skip) exit(1);
        same_file(ctx, paths[input], "invalid", 7);
        if (l_main(input == 3 ? 3 : 5, args) != 65) exit(1);
        put_file(paths[input], contents[input]);
        commands += 2;
    }
    release(ctx, original);
    remove("build/fault_main.l"); remove("build/fault_dep.l"); remove("build/fault-package.json"); remove("build/fault-close.lbc");
    remove("build/fault-invalid.lbc");
    printf("input close lifecycle: %u CLI failure/recovery checks passed\n", commands);
}
static void protected_output_failure(Context *ctx, const char *path, int error) {
    FILE *file = fopen("build/fault-output.lbc", "wb");
    if (!file) exit(1);
    fputs("unchanged", file); fclose(file);
    char *args[] = {"l", "compile", "examples/answer.l", "--manifest", "examples/package.json", "-o", "build/fault-output.lbc", NULL};
    fail_stat_path = path; fail_stat_error = error;
    if (l_main(7, args) != 74 || fail_stat_path) exit(1);
    size_t length;
    unsigned char *bytes = read_file(ctx, "build/fault-output.lbc", &length);
    if (length != 9 || memcmp(bytes, "unchanged", 9)) exit(1);
}
static void output_stat_failure(Context *ctx) { protected_output_failure(ctx, "build/fault-output.lbc", EACCES); }
static void manifest_stat_failure(Context *ctx) { protected_output_failure(ctx, "examples/package.json", ENOENT); }
static void source_stat_failure(Context *ctx) { protected_output_failure(ctx, canonical_path(ctx, "examples/answer.l"), EIO); }
static void bad_expr_analyze(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){return 0;}");
    ast->functions->body->body->expr->kind = (ExprKind)99;
    analyze(ctx, ast);
}
static void bad_stmt_analyze(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){return 0;}");
    ast->functions->body->body->kind = (StmtKind)99;
    analyze(ctx, ast);
}
static void bad_expr_lower(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){return 0;}"); analyze(ctx, ast);
    ast->functions->body->body->expr->kind = (ExprKind)99;
    (void)lower(ctx, ast);
}
static void bad_stmt_lower(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){return 0;}"); analyze(ctx, ast);
    ast->functions->body->body->kind = (StmtKind)99;
    (void)lower(ctx, ast);
}
static void bad_constant_kind(Context *ctx) {
    Ast *ast = frontend(ctx, "const int n=1;int main(){return n;}"); analyze(ctx, ast);
    ast->globals->state = 0; ast->globals->value->kind = (ExprKind)99;
    evaluate_constants(ctx, ast);
}
static void bad_constant_unary(Context *ctx) {
    Ast *ast = frontend(ctx, "const int n=+1;int main(){return n;}"); analyze(ctx, ast);
    ast->globals->state = 0; ast->globals->value->op = '?';
    evaluate_constants(ctx, ast);
}
static void bad_constant_binary(Context *ctx) {
    Ast *ast = frontend(ctx, "const int n=1+1;int main(){return n;}"); analyze(ctx, ast);
    ast->globals->state = 0; ast->globals->value->op = '?';
    evaluate_constants(ctx, ast);
}
static void low_literal(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){return 0;}");
    ast->functions->body->body->expr->integer = INT64_C(-2147483649);
    analyze(ctx, ast);
}
static void break_outside_lower(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){return 0;}"); analyze(ctx, ast);
    ast->functions->body->body->kind = ST_BREAK;
    (void)lower(ctx, ast);
}
static void continue_outside_lower(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){return 0;}"); analyze(ctx, ast);
    ast->functions->body->body->kind = ST_CONTINUE;
    (void)lower(ctx, ast);
}
static void continue_in_switch_lower(Context *ctx) {
    Ast *ast = frontend(ctx, "int main(){switch(1){default:break;}return 0;}"); analyze(ctx, ast);
    ast->functions->body->body->cases->body->kind = ST_CONTINUE;
    (void)lower(ctx, ast);
}

static char generated[300000];
static void append(const char *text) {
    if (strlen(generated) + strlen(text) + 1 >= sizeof(generated)) exit(1);
    strcat(generated, text);
}
static void parameters(unsigned count) {
    for (unsigned i = 0; i < count; ++i) {
        char text[40]; snprintf(text, sizeof(text), "%sint a%u", i ? "," : "", i); append(text);
    }
}
static void many_functions(Context *ctx) {
    generated[0] = 0;
    for (unsigned i = 0; i <= L_MAX_FUNCTIONS; ++i) {
        char text[64]; snprintf(text, sizeof(text), "int f%u(){return 0;}\n", i); append(text);
    }
    (void)frontend(ctx, generated);
}
static void many_parameters(Context *ctx) {
    strcpy(generated, "int f("); parameters(L_MAX_SLOTS + 1); append("){return 0;}int main(){return 0;}");
    (void)frontend(ctx, generated);
}
static void locals(unsigned count) {
    strcpy(generated, "int main(){");
    for (unsigned i = 0; i < count; ++i) {
        char text[64]; snprintf(text, sizeof(text), "int a%u=0;", i); append(text);
    }
}
static void many_locals(Context *ctx) {
    locals(L_MAX_SLOTS + 1); append("return 0;}");
    analyze(ctx, frontend(ctx, generated));
}
static void many_temps(Context *ctx) {
    locals(L_MAX_SLOTS - 1); append("bool b=true&&false;return 0;}");
    Ast *ast = frontend(ctx, generated); analyze(ctx, ast); (void)lower(ctx, ast);
}
static void many_registers(Context *ctx) {
    strcpy(generated, "int main(){int n=0;");
    for (unsigned i = 0; i < L_MAX_REGISTERS; ++i) append("n=n+1;");
    append("return n;}");
    Ast *ast = frontend(ctx, generated); analyze(ctx, ast); (void)lower(ctx, ast);
}
static void many_instructions(Context *ctx) {
    strcpy(generated, "void f(){}int main(){");
    for (unsigned i = 0; i <= L_MAX_CODE; ++i) append("f();");
    append("return 0;}");
    Ast *ast = frontend(ctx, generated); analyze(ctx, ast); (void)lower(ctx, ast);
}
static void many_arguments(Context *ctx) {
    strcpy(generated, "void f("); parameters(64); append("){}int main(){");
    for (unsigned i = 0; i <= L_MAX_ARGS / 64; ++i) {
        append("f(");
        for (unsigned j = 0; j < 64; ++j) append(j ? ",0" : "0");
        append(");");
    }
    append("return 0;}");
    Ast *ast = frontend(ctx, generated); analyze(ctx, ast); (void)lower(ctx, ast);
}
static void switch_labels(unsigned count) {
    for (unsigned i = 0; i < count; ++i) {
        char text[40]; snprintf(text, sizeof(text), "case %u:", i); append(text);
    }
}
static void many_switch_labels(Context *ctx) {
    strcpy(generated, "int main(){switch(0){"); switch_labels(L_MAX_CASES + 1);
    append("break;}return 0;}");
    analyze(ctx, frontend(ctx, generated));
}
static void many_switch_entries(Context *ctx) {
    strcpy(generated, "int main(){switch(0){"); switch_labels(L_MAX_CASES);
    append("break;}switch(0){case 0:break;}return 0;}");
    Ast *ast = frontend(ctx, generated); analyze(ctx, ast); (void)lower(ctx, ast);
}

static void io_failure(Context *ctx, unsigned mode) {
    static const char *const bodies[] = {
        "return read_byte();", "write_byte(byte(255));return 0;", "write_string(\"\\0\\xff\");return 0;",
        "write_error(\"\\xff\\0\");return 0;", "write_error(\"x\");return 0;",
        "write_string(\"\");return 0;", "return read_byte();", "write_error(\"\");return 0;"
    };
    char text[512];
    snprintf(text, sizeof(text), "module std.io;pub extern int read_byte();pub extern void write_byte(byte b);"
        "pub extern void write_string(string s);pub extern void write_error(string s);int main(){%s}", bodies[mode]);
    Ast *ast = frontend(ctx, text); analyze(ctx, ast); Program *p = lower(ctx, ast); verify(ctx, p);
    io_stream = mode == 0 ? fopen(".", "rb") : mode == 5 || mode == 6 ? tmpfile() : fopen("/dev/full", "wb");
    if (!io_stream) exit(1);
    if (setvbuf(io_stream, NULL, mode == 2 || mode == 4 ? _IONBF : _IOFBF, BUFSIZ)) exit(1);
    if (mode == 5 || mode == 6) fail_read = 2; /* Reported errors even on empty/EOF operations. */
    if (mode == 7 && fputc('x', io_stream) == EOF) exit(1); /* Empty writes must flush pending failures. */
    (void)execute_program_io(ctx, p, io_stream, io_stream, io_stream);
}
static void io_read_failure(Context *ctx) { io_failure(ctx, 0); }
static void io_byte_flush_failure(Context *ctx) { io_failure(ctx, 1); }
static void io_string_write_failure(Context *ctx) { io_failure(ctx, 2); }
static void io_error_flush_failure(Context *ctx) { io_failure(ctx, 3); }
static void io_error_write_failure(Context *ctx) { io_failure(ctx, 4); }
static void io_reported_write_failure(Context *ctx) { io_failure(ctx, 5); }
static void io_reported_read_failure(Context *ctx) { io_failure(ctx, 6); }
static void io_empty_flush_failure(Context *ctx) { io_failure(ctx, 7); }

static unsigned cases;
static void check(void (*action)(Context *), int expected) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) exit(1);
    ctx->filename = "fault-test";
    if (!setjmp(ctx->failure)) action(ctx);
    if (ctx->status != expected) {
        fprintf(stderr, "fault test: expected %d, got %d\n", expected, ctx->status); exit(1);
    }
    if (fail_close || close_skip) exit(1);
    if (io_stream) { fclose(io_stream); io_stream = NULL; }
    cleanup(ctx); free(ctx);
    ++cases;
}

int main(void) {
    check(memory_one, 65); check(memory_total, 65); check(memory_system, 65);
    check(vector_growth, 0); check(vector_overflow, 65); check(vector_element_overflow, 65);
    check(missing_filename, 65); check(type_names, 0); check(syntax_depth, 65);
    check(nul_source, 65); check(nul_block, 65); check(nul_line, 65); check(lex_edges, 0);
    check(path_edges, 0);
    check(canonical_memory, 65);
    check(read_failure, 74); check(read_zero, 74); check(read_growth, 0); check(read_limit, 65); check(close_failure, 74);
    const size_t lengths[] = {0, 1, 4095, 4096, 4097, 8192, 9000};
    for (unsigned n = 0; n < sizeof(lengths) / sizeof(*lengths); ++n) {
        input_length = lengths[n]; returned_length = SIZE_MAX;
        FILE *file = fopen("build/fault-input", "wb");
        if (!file) return 1;
        for (size_t i = 0; i < input_length; ++i) if (fputc((unsigned char)i, file) == EOF) return 1;
        if (fclose(file)) return 1;
        check(input_close_failure, 74);
        if (returned_length != SIZE_MAX) return 1;
        check(input_close_recovery, 0);
    }
    check(read_failure_close, 74); check(read_zero_close, 74); check(read_limit_close, 65);
    check(input_close_lifecycle, 0);
    check(output_stat_failure, 0); check(manifest_stat_failure, 0); check(source_stat_failure, 0);
    check(bad_expr_analyze, 65); check(bad_stmt_analyze, 65);
    check(bad_expr_lower, 65); check(bad_stmt_lower, 65); check(low_literal, 65);
    check(bad_constant_kind, 65); check(bad_constant_unary, 65); check(bad_constant_binary, 65);
    check(break_outside_lower, 65); check(continue_outside_lower, 65);
    check(continue_in_switch_lower, 65); check(many_switch_labels, 65); check(many_switch_entries, 65);
    check(many_functions, 65); check(many_parameters, 65); check(many_locals, 65);
    check(many_temps, 65); check(many_registers, 65); check(many_instructions, 65); check(many_arguments, 65);
    check(io_read_failure, 70); check(io_byte_flush_failure, 70); check(io_string_write_failure, 70);
    check(io_error_flush_failure, 70); check(io_error_write_failure, 70);
    check(io_reported_write_failure, 70); check(io_reported_read_failure, 70); check(io_empty_flush_failure, 70);
    char *args[] = {"l", "check", "examples/answer.l", NULL};
    fail_allocation = true;
    if (l_main(3, args) != 71) return 1;
    ++cases;
    remove("build/fault-input"); remove("build/fault-output.lbc");
    printf("fault injection: %u cases passed\n", cases);
    return 0;
}
