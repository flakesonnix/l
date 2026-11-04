#include "l.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static int usage(void) {
    fputs("usage: l check|run|inspect FILE.l --manifest PACKAGE.json\n"
          "       l compile FILE.l --manifest PACKAGE.json -o FILE.lbc\n"
          "       l check|run|inspect FILE.lbc\n", stderr);
    return 64;
}

static void different_file(Context *ctx, const struct stat *output, const char *input) {
    struct stat source;
    if (stat(input, &source)) {
        ctx->status = 74; fail(ctx, 0, 0, "cannot inspect compiler input: %s", input);
    }
    if (source.st_dev == output->st_dev && source.st_ino == output->st_ino) {
        ctx->status = 64; fail(ctx, 0, 0, "bytecode output would overwrite compiler input: %s", input);
    }
}
static void protect_inputs(Context *ctx, const char *output, const char *manifest, const Ast *ast) {
    struct stat target;
    if (stat(output, &target)) {
        if (errno == ENOENT) return;
        ctx->status = 74; fail(ctx, 0, 0, "cannot inspect bytecode output");
    }
    different_file(ctx, &target, manifest);
    for (const Module *module = ast->modules; module; module = module->next)
        different_file(ctx, &target, module->path);
}

int l_main(int argc, char **argv) {
    if (argc < 3) return usage();
    bool compile = !strcmp(argv[1], "compile");
    bool check = !strcmp(argv[1], "check");
    bool run = !strcmp(argv[1], "run");
    bool dump = !strcmp(argv[1], "inspect");
    if (!compile && !check && !run && !dump) return usage();
    const char *input = NULL, *output = NULL, *manifest = NULL;
    for (int n = 2; n < argc; ++n) {
        if (!strcmp(argv[n], "--manifest")) {
            if (manifest || ++n == argc) return usage();
            manifest = argv[n];
        } else if (!strcmp(argv[n], "-o")) {
            if (!compile || output || ++n == argc) return usage();
            output = argv[n];
        } else if (argv[n][0] == '-' || input) return usage();
        else input = argv[n];
    }
    if (!input || (compile && !output)) return usage();
    if (compile) {
        if (!strcmp(input, output)) {
            fputs("l: error: input and output must be different paths\n", stderr);
            return 64;
        }
    }
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) { fputs("l: error: out of memory\n", stderr); return 71; }
    ctx->filename = input;
    if (!setjmp(ctx->failure)) {
        size_t length;
        unsigned char *bytes = read_file(ctx, input, &length);
        Program *p;
        size_t path_length = strlen(input);
        bool bytecode = path_length >= 4 && !strcmp(input + path_length - 4, ".lbc");
        if (length >= 4 && !memcmp(bytes, "LBC\0", 4)) bytecode = true;
        if (bytecode) {
            if (compile) fail(ctx, 0, 0, "compile expects source, not bytecode");
            p = read_bytecode(ctx, bytes, length);
        } else {
            if (!manifest) fail(ctx, 0, 0, "source compilation requires an explicit --manifest");
            ModuleConfig *config = read_manifest(ctx, manifest);
            Ast *ast = load_modules(ctx, config, input, bytes, length);
            analyze(ctx, ast);
            p = lower(ctx, ast);
            verify(ctx, p);
            if (compile) protect_inputs(ctx, output, manifest, ast);
        }
        if (compile) write_bytecode(ctx, p, output);
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
