#include "l.h"

#include <stdlib.h>
#include <string.h>

static int usage(void) {
    fputs("usage: l check FILE.l\n"
          "       l run FILE.l|FILE.lbc\n"
          "       l compile FILE.l -o FILE.lbc\n"
          "       l inspect FILE.l|FILE.lbc\n", stderr);
    return 64;
}

int l_main(int argc, char **argv) {
    if (argc < 3) return usage();
    bool compile = !strcmp(argv[1], "compile");
    bool check = !strcmp(argv[1], "check");
    bool run = !strcmp(argv[1], "run");
    bool dump = !strcmp(argv[1], "inspect");
    if (!compile && !check && !run && !dump) return usage();
    if (compile) {
        if (argc != 5 || strcmp(argv[3], "-o")) return usage();
        if (!strcmp(argv[2], argv[4])) {
            fputs("l: error: input and output must be different paths\n", stderr);
            return 64;
        }
    } else if (argc != 3) return usage();
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) { fputs("l: error: out of memory\n", stderr); return 71; }
    ctx->filename = argv[2];
    if (!setjmp(ctx->failure)) {
        size_t length;
        unsigned char *bytes = read_file(ctx, argv[2], &length);
        Program *p;
        size_t path_length = strlen(argv[2]);
        bool bytecode = path_length >= 4 && !strcmp(argv[2] + path_length - 4, ".lbc");
        if (length >= 4 && !memcmp(bytes, "LBC\0", 4)) bytecode = true;
        if (bytecode) {
            if (compile) fail(ctx, 0, 0, "compile expects source, not bytecode");
            p = read_bytecode(ctx, bytes, length);
        } else {
            size_t count;
            Token *tokens = lex(ctx, (const char *)bytes, length, &count);
            Ast *ast = parse(ctx, tokens, count);
            analyze(ctx, ast);
            p = lower(ctx, ast);
            verify(ctx, p);
        }
        if (compile) write_bytecode(ctx, p, argv[4]);
        if (run) ctx->status = (int)((uint32_t)execute_program(ctx, p) & 255u);
        if (dump) inspect(p, stdout);
    }
    int status = ctx->status;
    cleanup(ctx);
    free(ctx);
    return status;
}

#ifndef L_NO_MAIN
int main(int argc, char **argv) { return l_main(argc, argv); }
#endif
