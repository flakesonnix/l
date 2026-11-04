#include "l.h"

#include <string.h>

typedef struct Binding Binding;
struct Binding { Decl *decl; unsigned depth; Binding *next; };
typedef struct Enclosing Enclosing;
struct Enclosing { bool is_loop; unsigned breaks; Enclosing *parent; };
typedef struct { Context *ctx; Ast *ast; Function *fn; Binding *bindings; unsigned depth; uint32_t elements; Enclosing *enclosing; bool reachable, constant_expression; } Semantic;
static Type analyze_expr(Semantic *, Expr *);
static bool analyze_stmt(Semantic *, Stmt *);

static void require(Semantic *s, Token token, Type actual, Type expected) {
    if (actual != expected) fail(s->ctx, token.line, token.column, "expected %s, got %s", type_name(expected), type_name(actual));
}
static Binding *lookup(Semantic *s, Token name) {
    for (Binding *b = s->bindings; b; b = b->next) if (token_equal(b->decl->name, name)) return b;
    return NULL;
}
static void bind(Semantic *s, Decl *decl) {
    for (Binding *b = s->bindings; b && b->depth == s->depth; b = b->next)
        if (token_equal(b->decl->name, decl->name)) token_fail(s->ctx, decl->name, "duplicate local declaration");
    if (s->fn->slot_count == L_MAX_SLOTS) token_fail(s->ctx, decl->name, "too many local slots (maximum 1024)");
    if (s->elements > L_MAX_SLOTS_ELEMENTS - decl->array)
        token_fail(s->ctx, decl->name, "too many array elements in one function (maximum 65536)");
    s->elements += decl->array;
    decl->slot = s->fn->slot_count++;
    s->fn->slots[decl->slot] = decl->type;
    s->fn->lengths[decl->slot] = decl->array;
    Binding *b = allocate(s->ctx, sizeof(*b));
    b->decl = decl; b->depth = s->depth; b->next = s->bindings; s->bindings = b;
}
static bool function_named(const Function *fn, const Module *module, Token path) {
    return fn->module == module && token_equal(fn->scope, parent_scope(path)) && token_equal(fn->name, leaf_name(path));
}
static bool constant_named(const Constant *constant, const Module *module, Token path) {
    return constant->module == module && token_equal(constant->scope, parent_scope(path)) && token_equal(constant->name, leaf_name(path));
}
static Constant *find_constant(const Ast *ast, const Module *module, Token path) {
    for (Constant *constant = ast->constants; constant; constant = constant->next)
        if (constant_named(constant, module, path)) return constant;
    return NULL;
}
static bool symbol_named(const Ast *ast, const Module *module, Token path) {
    for (const Function *fn = ast->functions; fn; fn = fn->next) if (function_named(fn, module, path)) return true;
    if (find_constant(ast, module, path)) return true;
    for (Namespace *ns = module->namespaces; ns; ns = ns->next) if (token_equal(ns->name, path)) return true;
    return false;
}
static bool signature(const Function *fn, const Type *types, uint32_t count) {
    if (fn->parameter_count != count) return false;
    uint32_t n = 0;
    for (Decl *p = fn->parameters; p; p = p->next) if (p->type != types[n++]) return false;
    return true;
}
static Function *overload(Semantic *s, Module *module, Token path, const Type *types, uint32_t count) {
    bool found = false, visible = false, inaccessible = false;
    for (Function *fn = s->ast->functions; fn; fn = fn->next) {
        if (!function_named(fn, module, path)) continue;
        found = true;
        bool matches = signature(fn, types, count);
        if (module != s->fn->module && !fn->exported) { inaccessible = inaccessible || matches; continue; }
        visible = true;
        if (matches) return fn;
    }
    if (inaccessible || (found && !visible)) token_fail(s->ctx, path, "inaccessible symbol: declaration is private to its module");
    token_fail(s->ctx, path, found ? "no matching function overload" : "unknown function or qualified declaration");
}
static bool qualified_prefix(Token prefix, Token name) {
    /* Parser-produced paths use only '::', so a matching colon starts a separator. */
    return name.length > prefix.length + 2 && !memcmp(prefix.text, name.text, prefix.length) &&
        name.text[prefix.length] == ':';
}
typedef struct { Module *module; Token path; } ResolvedName;
static ResolvedName resolve_name(Semantic *s, Token name, bool callable) {
    bool qualified = memchr(name.text, ':', name.length) != NULL;
    Token first = name;
    if (qualified) first.length = (size_t)((const char *)memchr(name.text, ':', name.length) - name.text);
    if (lookup(s, first)) token_fail(s->ctx, name, "local binding is not callable or a namespace");
    Module *module = s->fn->module;
    Token scope = s->fn->scope;
    for (;;) {
        Token head = join_name(s->ctx, scope, first, "::");
        if (symbol_named(s->ast, module, head))
            return (ResolvedName){module, join_name(s->ctx, scope, name, "::")};
        if (!scope.length) break;
        scope = parent_scope(scope);
    }
    if (!qualified) {
        for (Import *item = module->imports; item; item = item->next)
            for (ImportName *binding = item->names; binding; binding = binding->next)
                if (token_equal(binding->binding, name)) return (ResolvedName){item->target, binding->name};
    } else {
        Import *best = NULL;
        for (Import *item = module->imports; item; item = item->next) {
            if (item->alias.length && token_equal(item->alias, first)) {
                Token rest = name; rest.text += first.length + 2; rest.length -= first.length + 2;
                return (ResolvedName){item->target, rest};
            }
            if (!item->alias.length && !item->names && qualified_prefix(item->qualifier, name) &&
                (!best || item->qualifier.length > best->qualifier.length)) best = item;
        }
        if (best) {
            Token rest = name; rest.text += best->qualifier.length + 2; rest.length -= best->qualifier.length + 2;
            return (ResolvedName){best->target, rest};
        }
    }
    token_fail(s->ctx, name, qualified ? "unknown qualified name; no unqualified fallback" :
               callable ? "unknown function" : "unknown local variable or constant");
}
static Constant *visible_constant(Semantic *s, ResolvedName name) {
    Constant *constant = find_constant(s->ast, name.module, name.path);
    if (constant && name.module != s->fn->module && !constant->exported)
        token_fail(s->ctx, name.path, "inaccessible symbol: constant is private to its module");
    return constant;
}
static Constant *resolve_constant(Semantic *s, Token name) {
    Constant *constant = visible_constant(s, resolve_name(s, name, false));
    if (!constant) token_fail(s->ctx, name, "declaration is not a scalar constant");
    return constant;
}
static Function *resolve_call(Semantic *s, Token name, const Type *types, uint32_t count) {
    ResolvedName resolved = resolve_name(s, name, true);
    if (visible_constant(s, resolved)) token_fail(s->ctx, name, "module constant is not callable");
    return overload(s, resolved.module, resolved.path, types, count);
}
static Decl *resolve_index(Semantic *s, Expr *e) {
    if (e->left->kind != EX_NAME) token_fail(s->ctx, e->left->token, "arrays must be indexed through a variable name");
    Binding *b = lookup(s, e->left->token);
    if (!b) token_fail(s->ctx, e->left->token, "unknown local variable");
    if (!b->decl->array) token_fail(s->ctx, e->left->token, "variable is not an array");
    require(s, e->right->token, analyze_expr(s, e->right), TY_INT);
    e->symbol = b->decl->slot;
    e->length = b->decl->array;
    e->type = b->decl->type;
    return b->decl;
}
static Decl *lvalue(Semantic *s, Expr *e) {
    if (e->kind != EX_NAME && e->kind != EX_INDEX)
        token_fail(s->ctx, e->token, "assignment requires a local variable or an array element");
    Binding *b;
    if (e->kind == EX_INDEX) {
        Decl *d = resolve_index(s, e);
        if (d->immutable) token_fail(s->ctx, e->token, "cannot modify const binding");
        return d;
    } else {
        b = lookup(s, e->token);
        if (!b) {
            (void)resolve_constant(s, e->token);
            token_fail(s->ctx, e->token, "cannot modify module constant");
        }
        if (b->decl->array) token_fail(s->ctx, e->token, "cannot assign to a whole array");
        e->symbol = b->decl->slot; e->type = b->decl->type;
    }
    if (b->decl->immutable) token_fail(s->ctx, e->token, "cannot modify const binding");
    return b->decl;
}
static Type analyze_expr(Semantic *s, Expr *e) {
    enter(s->ctx, e->token);
    switch (e->kind) {
    case EX_INT:
        if (e->integer > INT32_MAX || e->integer < INT32_MIN) token_fail(s->ctx, e->token, "integer literal exceeds int range");
        e->type = TY_INT; break;
    case EX_BOOL: e->type = TY_BOOL; break;
    case EX_NAME: {
        Binding *b = lookup(s, e->token);
        if (!b) {
            Constant *constant = resolve_constant(s, e->token);
            e->type = constant->type; e->constant = constant;
            if (!s->constant_expression) {
                e->kind = e->type == TY_BOOL ? EX_BOOL : EX_INT;
                e->integer = constant->integer;
            }
            break;
        }
        if (b->decl->array) token_fail(s->ctx, e->token, "array used without an index");
        e->symbol = b->decl->slot; e->type = b->decl->type; break;
    }
    case EX_INDEX:
        if (s->constant_expression) token_fail(s->ctx, e->token, "array access is not a module constant expression");
        (void)resolve_index(s, e); break;
    case EX_ASSIGN: {
        if (s->constant_expression) token_fail(s->ctx, e->token, "assignment is not a module constant expression");
        Decl *d = lvalue(s, e->left);
        require(s, e->token, analyze_expr(s, e->right), d->type);
        e->type = d->type; break;
    }
    case EX_POSTFIX:
        if (s->constant_expression) token_fail(s->ctx, e->token, "postfix update is not a module constant expression");
        require(s, e->token, lvalue(s, e->left)->type, TY_INT); e->type = TY_INT; break;
    case EX_UNARY:
        e->type = e->op == '!' ? TY_BOOL : TY_INT;
        require(s, e->token, analyze_expr(s, e->left), e->type); break;
    case EX_BINARY: {
        Type a = analyze_expr(s, e->left), b = analyze_expr(s, e->right);
        if (e->op == TK_AND || e->op == TK_OR) {
            require(s, e->token, a, TY_BOOL); require(s, e->token, b, TY_BOOL); e->type = TY_BOOL;
        } else if (e->op == TK_EQ || e->op == TK_NE) {
            if (a == TY_VOID || a != b) token_fail(s->ctx, e->token, "equality requires matching non-void types");
            e->type = TY_BOOL;
        } else {
            require(s, e->token, a, TY_INT); require(s, e->token, b, TY_INT);
            e->type = (e->op == '<' || e->op == '>' || e->op == TK_LE || e->op == TK_GE) ? TY_BOOL : TY_INT;
        }
        break;
    }
    case EX_CALL: {
        if (s->constant_expression) token_fail(s->ctx, e->token, "function call is not a module constant expression");
        if (e->left->kind != EX_NAME) token_fail(s->ctx, e->token, "Stage 0 supports direct function calls only");
        Type types[L_MAX_SLOTS]; uint32_t count = 0;
        for (ExprList *arg = e->args; arg; arg = arg->next) {
            if (count == L_MAX_SLOTS) token_fail(s->ctx, e->token, "too many function arguments");
            types[count++] = analyze_expr(s, arg->value);
        }
        Function *fn = resolve_call(s, e->left->token, types, count);
        uint32_t index = 0; for (Function *other = s->ast->functions; other != fn; other = other->next) ++index;
        e->symbol = index;
        e->type = fn->result; break;
    }
    default: token_fail(s->ctx, e->token, "invalid AST expression");
    }
    leave(s->ctx);
    return e->type;
}
static bool scoped_stmt(Semantic *s, Stmt *stmt) {
    Binding *saved = s->bindings;
    ++s->depth;
    bool falls = analyze_stmt(s, stmt);
    --s->depth; s->bindings = saved;
    return falls;
}
static bool analyze_sequence(Semantic *s, Stmt *first) {
    bool falls = true, reachable = s->reachable;
    for (Stmt *child = first; child; child = child->next) {
        s->reachable = reachable && falls;
        bool child_falls = analyze_stmt(s, child);
        falls = falls && child_falls;
    }
    s->reachable = reachable;
    return falls;
}
static bool analyze_stmt(Semantic *s, Stmt *stmt) {
    bool falls = true;
    enter(s->ctx, stmt->token);
    switch (stmt->kind) {
    case ST_BLOCK: {
        Binding *saved = s->bindings;
        ++s->depth;
        falls = analyze_sequence(s, stmt->body);
        --s->depth; s->bindings = saved; break;
    }
    case ST_DECL: {
        Decl *d = stmt->decl;
        if (d->array) {
            if (d->type != TY_INT && d->type != TY_BOOL)
                token_fail(s->ctx, d->name, "array element type must be int or bool");
            bind(s, d); break;
        }
        Type init = analyze_expr(s, d->value);
        if (d->type == TY_AUTO) d->type = init;
        if (d->type == TY_VOID) token_fail(s->ctx, d->name, "variable cannot have void type");
        require(s, d->name, init, d->type); bind(s, d); break;
    }
    case ST_EXPR: (void)analyze_expr(s, stmt->expr); break;
    case ST_RETURN:
        require(s, stmt->token, stmt->expr ? analyze_expr(s, stmt->expr) : TY_VOID, s->fn->result);
        falls = false; break;
    case ST_BREAK: {
        if (!s->enclosing) token_fail(s->ctx, stmt->token, "break requires an enclosing loop or switch");
        if (s->reachable) ++s->enclosing->breaks;
        falls = false; break;
    }
    case ST_CONTINUE: {
        Enclosing *target = s->enclosing;
        while (target && !target->is_loop) target = target->parent;
        if (!target) token_fail(s->ctx, stmt->token, "continue requires an enclosing loop");
        falls = false; break;
    }
    case ST_IF: {
        require(s, stmt->condition->token, analyze_expr(s, stmt->condition), TY_BOOL);
        bool a = scoped_stmt(s, stmt->body);
        bool b = stmt->other ? scoped_stmt(s, stmt->other) : true;
        falls = a || b; break;
    }
    case ST_FOR: {
        Binding *saved = s->bindings;
        ++s->depth;
        if (stmt->init) (void)analyze_stmt(s, stmt->init);
        if (stmt->condition) require(s, stmt->condition->token, analyze_expr(s, stmt->condition), TY_BOOL);
        if (stmt->step) (void)analyze_expr(s, stmt->step);
        Enclosing loop = { true, 0, s->enclosing };
        s->enclosing = &loop;
        (void)scoped_stmt(s, stmt->body);
        s->enclosing = loop.parent;
        --s->depth; s->bindings = saved; break;
    }
    case ST_WHILE:
        require(s, stmt->condition->token, analyze_expr(s, stmt->condition), TY_BOOL);
        {
            Enclosing loop = { true, 0, s->enclosing };
            s->enclosing = &loop;
            (void)scoped_stmt(s, stmt->body);
            s->enclosing = loop.parent;
        }
        break;
    case ST_SWITCH: {
        require(s, stmt->expr->token, analyze_expr(s, stmt->expr), TY_INT);
        Binding *saved = s->bindings;
        ++s->depth;
        Enclosing sw = { false, 0, s->enclosing };
        s->enclosing = &sw;
        bool has_default = false;
        uint32_t count = 0;
        for (SwitchCase *label = stmt->cases; label; label = label->next) ++count;
        if (count > L_MAX_CASES) token_fail(s->ctx, stmt->token, "too many switch labels (maximum 1024)");
        bool tail_falls = true;
        for (SwitchCase *label = stmt->cases; label; label = label->next) {
            if (label->is_default) {
                if (has_default) token_fail(s->ctx, label->token, "duplicate default label");
                has_default = true;
            } else {
                for (SwitchCase *other = stmt->cases; other != label; other = other->next)
                    if (!other->is_default && other->value == label->value)
                        token_fail(s->ctx, label->token, "duplicate case value");
            }
            tail_falls = analyze_sequence(s, label->body);
        }
        s->enclosing = sw.parent;
        --s->depth; s->bindings = saved;
        /* Every label is a possible entry. Earlier bodies either terminate or
           fall into later labels, so only a break, an unmatched selector, or
           reaching the last body's end can leave the switch normally. */
        falls = sw.breaks > 0 || !has_default || tail_falls;
        break;
    }
    case ST_EMPTY: break;
    default: token_fail(s->ctx, stmt->token, "invalid AST statement");
    }
    leave(s->ctx);
    return falls;
}

static void imports(Context *ctx, const Ast *ast, Module *module) {
    ctx->filename = module->path;
    for (Import *item = module->imports; item; item = item->next) {
        if (!item->target) token_fail(ctx, item->name, "unresolved import: module loading is required");
        if (item->alias.length && symbol_named(ast, module, item->alias))
            token_fail(ctx, item->alias, "module alias conflicts with a module-scope declaration");
        for (Import *other = module->imports; other; other = other->next) {
            if (item != other && item->alias.length && token_equal(item->alias, other->alias))
                token_fail(ctx, item->alias, "conflicting module aliases");
            for (ImportName *binding = other->names; binding; binding = binding->next)
                if (item->alias.length && token_equal(item->alias, binding->binding))
                    token_fail(ctx, item->alias, "module alias conflicts with a selective import");
        }
        for (ImportName *name = item->names; name; name = name->next) {
            bool found = false, visible = false;
            for (Function *fn = ast->functions; fn; fn = fn->next)
                if (function_named(fn, item->target, name->name)) { found = true; visible = visible || fn->exported; }
            Constant *constant = find_constant(ast, item->target, name->name);
            if (constant) { found = true; visible = constant->exported; }
            if (!found) token_fail(ctx, name->name, "unknown selectively imported declaration");
            if (!visible) token_fail(ctx, name->name, "inaccessible symbol: selective import requires pub");
            for (Import *other = module->imports; other; other = other->next)
                for (ImportName *binding = other->names; binding; binding = binding->next)
                    if (binding != name && token_equal(name->binding, binding->binding))
                        token_fail(ctx, name->binding, "ambiguous selective import binding; use explicit aliases");
        }
        for (Import *other = module->imports; other != item; other = other->next)
            if (other->target == item->target)
                fprintf(stderr, "%s:%u:%u: warning: duplicate import of %.*s\n", module->path,
                        item->name.line, item->name.column, (int)item->name.length, item->name.text);
    }
}
void analyze(Context *ctx, Ast *ast) {
    const char *saved = ctx->filename;
    for (Constant *constant = ast->constants; constant; constant = constant->next) {
        ctx->filename = constant->module->path;
        if (constant->type != TY_INT && constant->type != TY_BOOL)
            token_fail(ctx, constant->name, "module constant type must be explicit int or bool");
        Token full = join_name(ctx, constant->scope, constant->name, "::");
        for (Constant *other = ast->constants; other != constant; other = other->next)
            if (constant_named(other, constant->module, full)) token_fail(ctx, constant->name, "duplicate module constant declaration");
        for (Function *fn = ast->functions; fn; fn = fn->next)
            if (function_named(fn, constant->module, full)) token_fail(ctx, constant->name, "module constant conflicts with function declaration");
        for (Namespace *ns = constant->module->namespaces; ns; ns = ns->next)
            if (token_equal(ns->name, full)) token_fail(ctx, constant->name, "module constant conflicts with namespace declaration");
    }
    for (Module *module = ast->modules; module; module = module->next) imports(ctx, ast, module);
    bool main_found = false;
    for (Function *fn = ast->functions; fn; fn = fn->next) {
        ctx->filename = fn->module->path;
        if (fn->result == TY_AUTO) token_fail(ctx, fn->name, "function return type must be explicit");
        Type parameters[L_MAX_SLOTS]; uint32_t count = 0;
        for (Decl *p = fn->parameters; p; p = p->next)
            if (p->type == TY_VOID || p->type == TY_AUTO) token_fail(ctx, p->name, "parameter type must be int or bool");
            else parameters[count++] = p->type;
        for (Function *other = ast->functions; other != fn; other = other->next)
            if (other->module == fn->module && token_equal(fn->scope, other->scope) && token_equal(fn->name, other->name) && signature(other, parameters, count))
                token_fail(ctx, fn->name, "duplicate function signature");
        Token full = join_name(ctx, fn->scope, fn->name, "::");
        for (Namespace *ns = fn->module->namespaces; ns; ns = ns->next)
            if (token_equal(ns->name, full)) token_fail(ctx, fn->name, "function conflicts with namespace declaration");
        if (fn->module == ast->entry && !fn->scope.length && fn->name.length == 4 && !memcmp(fn->name.text, "main", 4)) {
            main_found = true;
            ast->entrypoint = fn;
            if (fn->result != TY_INT || fn->parameter_count) token_fail(ctx, fn->name, "entry point must have signature int main()");
        }
    }
    if (!main_found) { ctx->filename = ast->entry->path; fail(ctx, 0, 0, "missing entry point int main()"); }
    for (Constant *constant = ast->constants; constant; constant = constant->next) {
        ctx->filename = constant->module->path;
        Function scope = {.module = constant->module, .scope = constant->scope};
        Semantic s = {.ctx = ctx, .ast = ast, .fn = &scope, .reachable = true, .constant_expression = true};
        require(&s, constant->name, analyze_expr(&s, constant->value), constant->type);
    }
    evaluate_constants(ctx, ast);
    for (Function *fn = ast->functions; fn; fn = fn->next) {
        ctx->filename = fn->module->path;
        Semantic s = { ctx, ast, fn, NULL, 0, 0, NULL, true, false };
        for (Decl *p = fn->parameters; p; p = p->next) bind(&s, p);
        /* Parameters and the outermost function block share one scope. */
        bool falls = analyze_sequence(&s, fn->body->body);
        if (falls && fn->result != TY_VOID) token_fail(ctx, fn->name, "not all control-flow paths return a value");
    }
    ctx->filename = saved;
}
