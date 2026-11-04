#include "l.h"

#include <errno.h>
#include <string.h>
#include <unistd.h>

/* Filesystem resolution knows roots and packages, never declaration symbols. */
static ModuleRoot *module_root(Context *ctx, const ModuleConfig *config, Token name) {
    ModuleRoot *best = NULL;
    bool ambiguous = false;
    for (ModuleRoot *root = config->roots; root; root = root->next) {
        size_t n = root->prefix.length;
        if (n > name.length || memcmp(root->prefix.text, name.text, n) ||
            (n && n < name.length && name.text[n] != '.')) continue;
        if (!best || n > best->prefix.length) { best = root; ambiguous = false; }
        else if (n == best->prefix.length) ambiguous = true;
    }
    if (!best) token_fail(ctx, name, "missing package dependency: no registered module prefix");
    if (ambiguous) token_fail(ctx, name, "ambiguous module resolution: equally matching source-root registrations");
    return best;
}
static char *mapped_file(Context *ctx, const ModuleRoot *root, Token name) {
    size_t start = root->prefix.length ? root->prefix.length + 1 : 0;
    if (start > name.length) token_fail(ctx, name, "module not found: a source-root prefix has no implicit index module");
    char *suffix = allocate(ctx, name.length - start + 3);
    for (size_t n = start; n < name.length; ++n) suffix[n - start] = name.text[n] == '.' ? '/' : name.text[n];
    memcpy(suffix + name.length - start, ".l", 3);
    return relative_path(ctx, root->directory, suffix);
}
static char *module_file(Context *ctx, const ModuleRoot *root, Token name) {
    char *path = mapped_file(ctx, root, name);
    if (access(path, R_OK)) {
        if (errno == ENOENT || errno == ENOTDIR) fail(ctx, name.line, name.column, "module not found: %.*s", (int)name.length, name.text);
        token_fail(ctx, name, "inaccessible module: cannot read source file");
    }
    char *actual = canonical_path(ctx, path);
    if (strcmp(actual, path)) token_fail(ctx, name, "inaccessible module: source location is not canonical");
    return actual;
}
static bool dependency(const ModuleConfig *config, const char *from, const char *to) {
    if (!strcmp(from, to)) return true;
    for (PackageDependency *edge = config->dependencies; edge; edge = edge->next)
        if (!strcmp(edge->from, from) && !strcmp(edge->to, to)) return true;
    return false;
}
static Module *find_module(Module *modules, const char *package, Token name) {
    for (Module *module = modules; module; module = module->next)
        if (!strcmp(module->package, package) && token_equal(module->name, name)) return module;
    return NULL;
}
static Module *parse_module(Context *ctx, const char *path, const unsigned char *bytes, size_t length) {
    ctx->filename = path;
    size_t count; Token *tokens = lex(ctx, (const char *)bytes, length, &count);
    return parse(ctx, tokens, count)->entry;
}
/* Discovery registers the reachable source units and import edges before analysis. */
static void discover(Context *ctx, const ModuleConfig *config, Ast *ast) {
    Module **tail = &ast->modules->next;
    uint32_t count = 1;
    for (Module *module = ast->modules; module; module = module->next) {
        for (Import *item = module->imports; item; item = item->next) {
            ctx->filename = module->path;
            ModuleRoot *root = module_root(ctx, config, item->name);
            if (!dependency(config, module->package, root->package))
                token_fail(ctx, item->name, "missing package dependency: importing package has not declared this dependency");
            Module *target = find_module(ast->modules, root->package, item->name);
            if (!target) {
                if (++count > L_MAX_MODULES) token_fail(ctx, item->name, "too many source modules (maximum 256)");
                char *path = module_file(ctx, root, item->name);
                size_t size; unsigned char *text = read_file(ctx, path, &size);
                target = parse_module(ctx, path, text, size); target->package = root->package;
                if (!token_equal(target->name, item->name)) {
                    if (find_module(ast->modules, root->package, target->name))
                        token_fail(ctx, target->name, "duplicate module definition in package");
                    token_fail(ctx, target->name, "invalid module declaration: does not match canonical source-root path");
                }
                *tail = target; tail = &target->next;
            }
            item->target = target;
        }
    }
}
static void visit(Context *ctx, Module *module, Module **stack, unsigned depth, Module **order, unsigned *count) {
    if (module->state == 2) return;
    if (module->state == 1) {
        Token trace = {.text = ""}; unsigned begin = 0;
        while (stack[begin] != module) ++begin;
        for (unsigned n = begin; n < depth; ++n) trace = join_name(ctx, trace, stack[n]->name, " -> ");
        trace = join_name(ctx, trace, module->name, " -> ");
        ctx->filename = module->path;
        fail(ctx, 0, 0, "Module dependency cycle detected: %.*s\nCircular module dependencies are not supported in Language L 0.1.",
             (int)trace.length, trace.text);
    }
    module->state = 1; stack[depth] = module;
    for (Import *item = module->imports; item; item = item->next) visit(ctx, item->target, stack, depth + 1, order, count);
    module->state = 2; order[(*count)++] = module;
}
Ast *load_modules(Context *ctx, const ModuleConfig *config, const char *entry, const unsigned char *bytes, size_t length) {
    const char *saved = ctx->filename;
    char *path = canonical_path(ctx, entry);
    Module *module = parse_module(ctx, path, bytes, length);
    ModuleRoot *root = module_root(ctx, config, module->name);
    if (strcmp(root->package, config->package)) token_fail(ctx, module->name, "inaccessible module: entry is not in the configured package");
    if (strcmp(mapped_file(ctx, root, module->name), path))
        token_fail(ctx, module->name, "invalid module declaration: entry does not match canonical source-root path");
    module->package = root->package;
    Ast *ast = allocate(ctx, sizeof(*ast)); ast->modules = ast->entry = module;
    discover(ctx, config, ast);
    Module *stack[L_MAX_MODULES], *order[L_MAX_MODULES]; unsigned count = 0;
    visit(ctx, module, stack, 0, order, &count);
    Function **tail = &ast->functions;
    Global **constants = &ast->globals;
    TypeAlias **aliases = &ast->aliases;
    for (unsigned n = 0; n < count; ++n) {
        ctx->filename = order[n]->path;
        for (Function *fn = order[n]->functions; fn;) {
            if (ast->function_count++ == L_MAX_FUNCTIONS) token_fail(ctx, fn->name, "too many functions across modules (maximum 256)");
            Function *next = fn->next; *tail = fn; tail = &fn->next; fn = next;
        }
        for (Global *constant = order[n]->globals; constant;) {
            if (constant->is_static) {
                if (ast->static_count++ == L_MAX_GLOBALS)
                    token_fail(ctx, constant->name, "too many static globals across modules (maximum 1024)");
            } else if (ast->constant_count++ == L_MAX_CONSTANTS)
                token_fail(ctx, constant->name, "too many module constants across modules (maximum 1024)");
            Global *next = constant->next; *constants = constant; constants = &constant->next; constant = next;
        }
        for (TypeAlias *alias = order[n]->aliases; alias;) {
            if (ast->alias_count++ == L_MAX_ALIASES)
                token_fail(ctx, alias->name, "too many type aliases across modules (maximum 1024)");
            TypeAlias *next = alias->next; *aliases = alias; aliases = &alias->next; alias = next;
        }
    }
    *tail = NULL;
    *constants = NULL;
    *aliases = NULL;
    ctx->filename = saved;
    return ast;
}
