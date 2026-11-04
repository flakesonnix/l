#include "../bootstrap/stage0/l.h"

#include <stdlib.h>
#include <string.h>

/* Linker interposition exercises real error handling without production hooks. */
void *__real_calloc(size_t, size_t);
size_t __real_fread(void *, size_t, size_t, FILE *);
int __real_ferror(FILE *);
int __real_fclose(FILE *);
static bool fail_allocation;
static int fail_read;
static bool fail_close;

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
    if (fail_close) { fail_close = false; return EOF; }
    return result;
}

static Ast *frontend(Context *ctx, const char *source) {
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
    if (strcmp(type_name(TY_AUTO), "auto") || strcmp(type_name((Type)99), "invalid")) exit(1);
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

static void check(void (*action)(Context *), int expected) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) exit(1);
    ctx->filename = "fault-test";
    if (!setjmp(ctx->failure)) action(ctx);
    if (ctx->status != expected) {
        fprintf(stderr, "fault test: expected %d, got %d\n", expected, ctx->status); exit(1);
    }
    cleanup(ctx); free(ctx);
}

int main(void) {
    check(memory_one, 65); check(memory_total, 65); check(memory_system, 65);
    check(vector_growth, 0); check(vector_overflow, 65); check(vector_element_overflow, 65);
    check(missing_filename, 65); check(type_names, 0); check(syntax_depth, 65);
    check(nul_source, 65); check(nul_block, 65); check(nul_line, 65); check(lex_edges, 0);
    check(read_failure, 74); check(read_zero, 74); check(read_growth, 0); check(read_limit, 65); check(close_failure, 74);
    check(bad_expr_analyze, 65); check(bad_stmt_analyze, 65);
    check(bad_expr_lower, 65); check(bad_stmt_lower, 65); check(low_literal, 65);
    check(break_outside_lower, 65); check(continue_outside_lower, 65);
    check(continue_in_switch_lower, 65); check(many_switch_labels, 65); check(many_switch_entries, 65);
    check(many_functions, 65); check(many_parameters, 65); check(many_locals, 65);
    check(many_temps, 65); check(many_registers, 65); check(many_instructions, 65); check(many_arguments, 65);
    char *args[] = {"l", "check", "examples/answer.l", NULL};
    fail_allocation = true;
    if (l_main(3, args) != 71) return 1;
    remove("build/fault-input"); remove("build/fault-output.lbc");
    puts("fault injection: 36 cases passed");
    return 0;
}
