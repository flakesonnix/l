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
static bool global_named(const Global *constant, const Module *module, Token path) {
    return constant->module == module && token_equal(constant->scope, parent_scope(path)) && token_equal(constant->name, leaf_name(path));
}
static Global *find_global(const Ast *ast, const Module *module, Token path) {
    for (Global *constant = ast->globals; constant; constant = constant->next)
        if (global_named(constant, module, path)) return constant;
    for (Enum *enumeration = ast->enums; enumeration; enumeration = enumeration->next)
        for (Global *member = enumeration->members; member; member = member->next)
            if (global_named(member, module, path)) return member;
    return NULL;
}
static bool alias_named(const TypeAlias *alias, const Module *module, Token path) {
    return alias->module == module && token_equal(alias->scope, parent_scope(path)) && token_equal(alias->name, leaf_name(path));
}
static TypeAlias *find_alias(const Ast *ast, const Module *module, Token path) {
    for (TypeAlias *alias = ast->aliases; alias; alias = alias->next)
        if (alias_named(alias, module, path)) return alias;
    return NULL;
}
static bool struct_named(const Struct *record, const Module *module, Token path) {
    return record->module == module && token_equal(record->scope, parent_scope(path)) && token_equal(record->name, leaf_name(path));
}
static Struct *find_struct(const Ast *ast, const Module *module, Token path) {
    for (Struct *record = ast->structs; record; record = record->next)
        if (struct_named(record, module, path)) return record;
    return NULL;
}
static bool enum_named(const Enum *enumeration, const Module *module, Token path) {
    return enumeration->module == module && token_equal(enumeration->scope, parent_scope(path)) &&
        token_equal(enumeration->name, leaf_name(path));
}
static Enum *find_enum(const Ast *ast, const Module *module, Token path) {
    for (Enum *enumeration = ast->enums; enumeration; enumeration = enumeration->next)
        if (enum_named(enumeration, module, path)) return enumeration;
    return NULL;
}
static bool symbol_named(const Ast *ast, const Module *module, Token path) {
    for (const Function *fn = ast->functions; fn; fn = fn->next) if (function_named(fn, module, path)) return true;
    if (find_global(ast, module, path)) return true;
    if (find_alias(ast, module, path)) return true;
    if (find_struct(ast, module, path)) return true;
    if (find_enum(ast, module, path)) return true;
    for (Namespace *ns = module->namespaces; ns; ns = ns->next) if (token_equal(ns->name, path)) return true;
    return false;
}
static bool signature(const Function *fn, const Type *types, uint32_t count) {
    if (fn->parameter_count != count) return false;
    uint32_t n = 0;
    for (Decl *p = fn->parameters; p; p = p->next) if (p->type != types[n++]) return false;
    return true;
}
static bool token_text(Token token, const char *text) {
    return token.length == strlen(text) && !memcmp(token.text, text, token.length);
}
static Intrinsic intrinsic_of(Token name, Type result, const Type *parameters, uint32_t count) {
    if (count == 1 && result == TY_VOID) {
        if (token_text(name, "write_byte") && parameters[0] == TY_BYTE) return IN_WRITE_BYTE;
        if (token_text(name, "write_string") && parameters[0] == TY_STRING) return IN_WRITE_STRING;
        if (token_text(name, "write_error") && parameters[0] == TY_STRING) return IN_WRITE_ERROR;
    }
    if (token_text(name, "read_byte") && result == TY_INT && !count) return IN_READ_BYTE;
    return IN_NONE;
}
static void check_intrinsic(Context *ctx, Function *fn) {
    /* The VM supplies the only supported extern bodies: the fixed std.io stream intrinsics. */
    if (!fn->is_extern) return;
    if (!fn->exported) token_fail(ctx, fn->name, "extern declarations must be public");
    if (fn->scope.length) token_fail(ctx, fn->name, "extern declarations must not be declared in namespaces");
    if (!token_text(fn->module->name, "std.io"))
        token_fail(ctx, fn->name, "extern declarations are only supported in module std.io");
    Type parameters[L_MAX_SLOTS]; uint32_t count = 0;
    for (Decl *p = fn->parameters; p; p = p->next) parameters[count++] = p->type;
    Intrinsic intrinsic = intrinsic_of(fn->name, fn->result, parameters, count);
    if (intrinsic == IN_NONE) token_fail(ctx, fn->name, "unsupported std.io intrinsic declaration");
    fn->intrinsic = intrinsic;
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
    for (Import *item = module->imports; item; item = item->next)
        for (ImportName *binding = item->names; binding; binding = binding->next)
            if (token_equal(binding->binding, first)) {
                if (!qualified) return (ResolvedName){item->target, binding->name};
                Token rest = name; rest.text += first.length + 2; rest.length -= first.length + 2;
                return (ResolvedName){item->target, join_name(s->ctx, binding->name, rest, "::")};
            }
    if (qualified) {
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
static Global *visible_global(Semantic *s, ResolvedName name) {
    Global *constant = find_global(s->ast, name.module, name.path);
    if (constant && name.module != s->fn->module && !constant->exported)
        token_fail(s->ctx, name.path, "inaccessible symbol: declaration is private to its module");
    return constant;
}
static TypeAlias *visible_alias(Semantic *s, ResolvedName name) {
    TypeAlias *alias = find_alias(s->ast, name.module, name.path);
    if (alias && name.module != s->fn->module && !alias->exported)
        token_fail(s->ctx, name.path, "inaccessible symbol: type alias is private to its module");
    return alias;
}
static Struct *visible_struct(Semantic *s, ResolvedName name) {
    Struct *record = find_struct(s->ast, name.module, name.path);
    if (record && name.module != s->fn->module && !record->exported)
        token_fail(s->ctx, name.path, "inaccessible symbol: struct is private to its module");
    return record;
}
static Struct *struct_type(Semantic *s, Type type) {
    Struct *record = s->ast->structs;
    for (uint32_t n = TY_STRUCT; n < (uint32_t)type; ++n) record = record->next;
    return record;
}
static Enum *visible_enum(Semantic *s, ResolvedName name) {
    Enum *enumeration = find_enum(s->ast, name.module, name.path);
    if (enumeration && name.module != s->fn->module && !enumeration->exported)
        token_fail(s->ctx, name.path, "inaccessible symbol: enum is private to its module");
    return enumeration;
}
static void public_type(Semantic *s, Token name, Type type) {
    if (IS_STRUCT(type) && !struct_type(s, type)->exported)
        token_fail(s->ctx, name, "public signature exposes a private struct type");
    if (IS_ENUM(type)) {
        Enum *enumeration = s->ast->enums;
        for (uint32_t n = TY_ENUM; n < (uint32_t)type; ++n) enumeration = enumeration->next;
        if (!enumeration->exported) token_fail(s->ctx, name, "public interface exposes a private enum type");
    }
}
static Type resolve_alias(Context *, Ast *, TypeAlias *, TypeAlias *);
static Type resolve_type(Semantic *s, Type type, Token name, TypeAlias *parent) {
    if (type != TY_NAMED) return type;
    ResolvedName resolved = resolve_name(s, name, false);
    Struct *record = visible_struct(s, resolved);
    if (record) return (Type)(TY_STRUCT + record->symbol);
    Enum *enumeration = visible_enum(s, resolved);
    if (enumeration) return (Type)(TY_ENUM + enumeration->symbol);
    TypeAlias *alias = visible_alias(s, resolved);
    if (!alias) token_fail(s->ctx, name, "declaration is not a type alias, struct or enum");
    return resolve_alias(s->ctx, s->ast, alias, parent);
}
static Token alias_name(Context *ctx, const TypeAlias *alias) {
    Token name = join_name(ctx, alias->scope, alias->name, "::");
    return join_name(ctx, alias->module->qualifier, name, "::");
}
static Type resolve_alias(Context *ctx, Ast *ast, TypeAlias *alias, TypeAlias *parent) {
    if (alias->state == 2) return alias->type;
    const char *saved = ctx->filename; ctx->filename = alias->module->path;
    if (alias->state == 1) {
        TypeAlias *path[L_MAX_DEPTH]; unsigned count = 0;
        for (TypeAlias *node = parent; node != alias; node = node->parent) path[count++] = node;
        Token trace = alias_name(ctx, alias);
        while (count) trace = join_name(ctx, trace, alias_name(ctx, path[--count]), " -> ");
        trace = join_name(ctx, trace, alias_name(ctx, alias), " -> ");
        fail(ctx, alias->name.line, alias->name.column, "type alias dependency cycle detected: %.*s", (int)trace.length, trace.text);
    }
    enter(ctx, alias->name);
    alias->state = 1; alias->parent = parent;
    Function scope = {.module = alias->module, .scope = alias->scope};
    Semantic s = {.ctx = ctx, .ast = ast, .fn = &scope};
    alias->type = resolve_type(&s, alias->type, alias->target_name, alias);
    if (alias->type != TY_INT && alias->type != TY_BOOL && alias->type != TY_BYTE && alias->type != TY_STRING)
        token_fail(ctx, alias->name, "type alias target must be int or bool or byte or string");
    alias->state = 2; alias->parent = NULL;
    leave(ctx); ctx->filename = saved;
    return alias->type;
}
static Global *resolve_global(Semantic *s, Token name) {
    ResolvedName resolved = resolve_name(s, name, false);
    Global *constant = visible_global(s, resolved);
    if (!constant && visible_alias(s, resolved)) token_fail(s->ctx, name, "type alias is not a value");
    if (!constant && visible_struct(s, resolved)) token_fail(s->ctx, name, "struct type is not a value");
    if (!constant && visible_enum(s, resolved)) token_fail(s->ctx, name, "enum type is not a value; select a member");
    if (!constant) token_fail(s->ctx, name, "declaration is not a scalar constant");
    return constant;
}
static Function *resolve_call(Semantic *s, Token name, const Type *types, uint32_t count) {
    ResolvedName resolved = resolve_name(s, name, true);
    Global *global = visible_global(s, resolved);
    if (global) token_fail(s->ctx, name, global->is_static ? "static storage is not callable" : "module constant is not callable");
    if (visible_alias(s, resolved)) token_fail(s->ctx, name, "type alias is not callable");
    if (visible_struct(s, resolved)) token_fail(s->ctx, name, "struct type is not callable; use a struct literal");
    if (visible_enum(s, resolved)) token_fail(s->ctx, name, "enum type is not callable");
    return overload(s, resolved.module, resolved.path, types, count);
}
static Decl *resolve_index(Semantic *s, Expr *e) {
    if (e->left->kind != EX_NAME) token_fail(s->ctx, e->left->token, "arrays must be indexed through a variable name");
    Binding *b = lookup(s, e->left->token);
    if (b) {
        if (!b->decl->array) token_fail(s->ctx, e->left->token, "variable is not an array");
        e->symbol = b->decl->slot;
        e->length = b->decl->array;
        e->type = b->decl->type;
    } else {
        Global *global = resolve_global(s, e->left->token);
        if (!global->length) token_fail(s->ctx, e->left->token, "variable is not an array");
        e->global = global; e->symbol = global->symbol; e->length = global->array; e->type = global->type;
    }
    require(s, e->right->token, analyze_expr(s, e->right), TY_INT);
    return b ? b->decl : NULL;
}
static Type resolve_field(Semantic *s, Expr *e, Type type) {
    if (!IS_STRUCT(type)) token_fail(s->ctx, e->token, "field access requires a struct value");
    uint32_t index = 0;
    for (Field *field = struct_type(s, type)->fields; field; field = field->next, ++index) {
        if (!token_equal(field->name, e->token)) continue;
        e->symbol = index; e->type = field->type; return e->type;
    }
    token_fail(s->ctx, e->token, "unknown struct field");
}
static Type lvalue(Semantic *s, Expr *e) {
    if (e->kind == EX_FIELD) {
        if (e->left->kind != EX_NAME) token_fail(s->ctx, e->token, "field mutation requires a local struct binding");
        Binding *binding = lookup(s, e->left->token);
        if (!binding) token_fail(s->ctx, e->token, "field mutation requires a local struct binding");
        if (binding->decl->immutable) token_fail(s->ctx, e->token, "cannot modify const binding");
        e->left->type = binding->decl->type; e->left->symbol = binding->decl->slot;
        return resolve_field(s, e, binding->decl->type);
    }
    if (e->kind != EX_NAME && e->kind != EX_INDEX)
        token_fail(s->ctx, e->token, "assignment requires a local variable or an array element");
    Binding *b;
    if (e->kind == EX_INDEX) {
        Decl *d = resolve_index(s, e);
        if (d && d->immutable) token_fail(s->ctx, e->token, "cannot modify const binding");
        return e->type;
    } else {
        b = lookup(s, e->token);
        if (!b) {
            Global *global = resolve_global(s, e->token);
            if (!global->is_static) token_fail(s->ctx, e->token, "cannot modify module constant");
            if (global->length) token_fail(s->ctx, e->token, "cannot assign to a whole array");
            e->kind = EX_GLOBAL; e->symbol = global->symbol; e->type = global->type; e->global = global;
            return e->type;
        }
        if (b->decl->array) token_fail(s->ctx, e->token, "cannot assign to a whole array");
        e->symbol = b->decl->slot; e->type = b->decl->type;
    }
    if (b->decl->immutable) token_fail(s->ctx, e->token, "cannot modify const binding");
    return b->decl->type;
}
static uint32_t intern_string(Semantic *s, Token token) {
    Ast *ast = s->ast;
    IrString value = {(uint32_t)token.length, (const unsigned char *)token.text};
    for (uint32_t n = 0; n < ast->string_count; ++n) if (string_equal(ast->strings[n], value)) return n;
    if (ast->string_count == L_MAX_STRINGS) token_fail(s->ctx, token, "too many distinct strings (maximum 1024)");
    if (value.length > L_MAX_STRING_BYTES - ast->string_bytes) token_fail(s->ctx, token, "string table exceeds 1048576 bytes");
    ast->string_bytes += value.length;
    reserve(s->ctx, (void **)&ast->strings, &ast->string_capacity, ast->string_count + 1, sizeof(*ast->strings));
    ast->strings[ast->string_count] = value; return ast->string_count++;
}
static Type analyze_expr(Semantic *s, Expr *e) {
    enter(s->ctx, e->token);
    switch (e->kind) {
    case EX_CONDITIONAL: {
        if (s->constant_expression) token_fail(s->ctx, e->token, "conditional is not a compile-time constant expression");
        require(s, e->condition->token, analyze_expr(s, e->condition), TY_BOOL);
        /* Both alternatives are checked, even when the condition is a literal. */
        Type yes = analyze_expr(s, e->left), no = analyze_expr(s, e->right);
        require(s, e->right->token, no, yes);
        if (yes != TY_INT && yes != TY_BOOL)
            token_fail(s->ctx, e->token, "conditional branches must have int or bool type");
        e->type = yes; break;
    }
    case EX_LET: {
        if (s->constant_expression) token_fail(s->ctx, e->token, "let is not a compile-time constant expression");
        Binding *saved = s->bindings;
        ++s->depth;
        for (Decl *d = e->bindings; d; d = d->next) {
            d->type = resolve_type(s, d->type, d->type_name, NULL);
            /* Eager, sequential scope: the initializer sees outer/earlier bindings only. */
            Type init = analyze_expr(s, d->value);
            if (d->type == TY_AUTO) d->type = init;
            if (d->type != TY_INT && d->type != TY_BOOL)
                token_fail(s->ctx, d->name, "let binding type must be int or bool");
            require(s, d->name, init, d->type);
            bind(s, d);
        }
        e->type = analyze_expr(s, e->right);
        if (e->type != TY_INT && e->type != TY_BOOL)
            token_fail(s->ctx, e->token, "let body must have int or bool type");
        --s->depth; s->bindings = saved;
        break;
    }
    case EX_INT:
        if (e->integer > INT32_MAX || e->integer < INT32_MIN) token_fail(s->ctx, e->token, "integer literal exceeds int range");
        e->type = TY_INT; break;
    case EX_BOOL: e->type = TY_BOOL; break;
    case EX_STRING: e->type = TY_STRING; e->integer = intern_string(s, e->token); break;
    case EX_CONVERT:
        require(s, e->token, analyze_expr(s, e->left), e->type == TY_BYTE ? TY_INT : TY_BYTE); break;
    case EX_STRUCT: {
        if (s->constant_expression) token_fail(s->ctx, e->token, "struct literal is not a constant expression");
        if (e->left->kind != EX_NAME) token_fail(s->ctx, e->token, "struct literal requires a named struct type");
        e->type = resolve_type(s, TY_NAMED, e->left->token, NULL);
        if (!IS_STRUCT(e->type)) token_fail(s->ctx, e->token, "struct literal requires a struct type");
        Field *field = struct_type(s, e->type)->fields;
        for (ExprList *arg = e->args; arg; arg = arg->next) {
            if (!field) token_fail(s->ctx, e->token, "wrong number of struct initializer fields");
            require(s, arg->value->token, analyze_expr(s, arg->value), field->type); field = field->next;
        }
        if (field) token_fail(s->ctx, e->token, "wrong number of struct initializer fields");
        break;
    }
    case EX_FIELD: {
        Type type = analyze_expr(s, e->left);
        if (type == TY_STRING) {
            if (e->token.length != 6 || memcmp(e->token.text, "length", 6)) token_fail(s->ctx, e->token, "string has only a length property");
            e->kind = EX_LENGTH; e->type = TY_INT;
        } else (void)resolve_field(s, e, type);
        break;
    }
    case EX_NAME: {
        Binding *b = lookup(s, e->token);
        if (!b) {
            Global *constant = resolve_global(s, e->token);
            if (constant->length) token_fail(s->ctx, e->token, "array used without an index");
            e->type = constant->type; e->global = constant;
            if (constant->is_static) {
                if (s->constant_expression) token_fail(s->ctx, e->token, "mutable static storage is not a constant expression");
                e->kind = EX_GLOBAL; e->symbol = constant->symbol;
            } else if (!s->constant_expression) {
                e->kind = e->type == TY_BOOL ? EX_BOOL : EX_INT;
                e->integer = constant->integer;
            }
            break;
        }
        if (s->constant_expression) token_fail(s->ctx, e->token, "local binding is not a compile-time constant");
        if (b->decl->array) token_fail(s->ctx, e->token, "array used without an index");
        e->symbol = b->decl->slot; e->type = b->decl->type; break;
    }
    case EX_INDEX: {
        Binding *binding = e->left->kind == EX_NAME ? lookup(s, e->left->token) : NULL;
        Global *global = !binding && e->left->kind == EX_NAME ? resolve_global(s, e->left->token) : NULL;
        if ((binding && binding->decl->array) || (global && global->length)) {
            if (s->constant_expression) token_fail(s->ctx, e->token, "array access is not a constant expression");
            (void)resolve_index(s, e);
        } else {
            require(s, e->token, analyze_expr(s, e->left), TY_STRING);
            require(s, e->token, analyze_expr(s, e->right), TY_INT);
            e->kind = EX_STRING_INDEX; e->type = TY_BYTE;
        }
        break;
    }
    case EX_ASSIGN: {
        if (s->constant_expression) token_fail(s->ctx, e->token, "assignment is not a constant expression");
        Type type = lvalue(s, e->left);
        require(s, e->token, analyze_expr(s, e->right), type);
        e->type = type; break;
    }
    case EX_POSTFIX:
        if (s->constant_expression) token_fail(s->ctx, e->token, "postfix update is not a constant expression");
        require(s, e->token, lvalue(s, e->left), TY_INT); e->type = TY_INT; break;
    case EX_UNARY:
        e->type = e->op == '!' ? TY_BOOL : TY_INT;
        require(s, e->token, analyze_expr(s, e->left), e->type); break;
    case EX_BINARY: {
        Type a = analyze_expr(s, e->left), b = analyze_expr(s, e->right);
        if (e->op == TK_AND || e->op == TK_OR) {
            require(s, e->token, a, TY_BOOL); require(s, e->token, b, TY_BOOL); e->type = TY_BOOL;
        } else if (e->op == TK_EQ || e->op == TK_NE) {
            if (a == TY_VOID || IS_STRUCT(a) || a != b) token_fail(s->ctx, e->token, "equality requires matching scalar types");
            e->type = TY_BOOL;
        } else {
            require(s, e->token, a, TY_INT); require(s, e->token, b, TY_INT);
            e->type = (e->op == '<' || e->op == '>' || e->op == TK_LE || e->op == TK_GE) ? TY_BOOL : TY_INT;
        }
        break;
    }
    case EX_CALL: {
        if (s->constant_expression) token_fail(s->ctx, e->token, "function call is not a constant expression");
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
static int32_t typed_constant(Semantic *s, Expr *expr, Type type) {
    bool saved = s->constant_expression;
    s->constant_expression = true;
    require(s, expr->token, analyze_expr(s, expr), type);
    s->constant_expression = saved;
    return evaluate_constant_expression(s->ctx, s->ast, expr);
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
        d->type = resolve_type(s, d->type, d->type_name, NULL);
        if (d->length) {
            if (d->type != TY_INT && d->type != TY_BOOL && d->type != TY_BYTE)
                token_fail(s->ctx, d->name, "array element type must be int or bool or byte");
            int32_t length = typed_constant(s, d->length, TY_INT);
            if (length < 1 || (uint32_t)length > L_MAX_ARRAY)
                token_fail(s->ctx, d->length->token, "array length must be between 1 and 65535");
            d->array = (uint32_t)length;
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
        Type selector = analyze_expr(s, stmt->expr);
        if (selector != TY_INT && selector != TY_BYTE && !IS_ENUM(selector)) token_fail(s->ctx, stmt->expr->token, "switch selector must be int, byte or enum");
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
                label->value = typed_constant(s, label->expr, selector);
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
            Global *constant = find_global(ast, item->target, name->name);
            if (constant) { found = true; visible = constant->exported; }
            TypeAlias *alias = find_alias(ast, item->target, name->name);
            if (alias) { found = true; visible = alias->exported; }
            Struct *record = find_struct(ast, item->target, name->name);
            if (record) { found = true; visible = record->exported; }
            Enum *enumeration = find_enum(ast, item->target, name->name);
            if (enumeration) { found = true; visible = enumeration->exported; }
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
    uint32_t enum_index = 0;
    for (Enum *enumeration = ast->enums; enumeration; enumeration = enumeration->next) {
        ctx->filename = enumeration->module->path; enumeration->symbol = enum_index++;
        if (!enumeration->member_count) token_fail(ctx, enumeration->name, "enum must have at least one member");
        Token full = join_name(ctx, enumeration->scope, enumeration->name, "::");
        for (Enum *other = ast->enums; other != enumeration; other = other->next)
            if (enum_named(other, enumeration->module, full)) token_fail(ctx, enumeration->name, "duplicate enum declaration");
        if (find_global(ast, enumeration->module, full)) token_fail(ctx, enumeration->name, "enum conflicts with module constant/static storage");
        if (find_struct(ast, enumeration->module, full)) token_fail(ctx, enumeration->name, "enum conflicts with struct declaration");
        if (find_alias(ast, enumeration->module, full)) token_fail(ctx, enumeration->name, "enum conflicts with type alias declaration");
        for (Function *fn = ast->functions; fn; fn = fn->next)
            if (function_named(fn, enumeration->module, full)) token_fail(ctx, enumeration->name, "enum conflicts with function declaration");
        for (Namespace *ns = enumeration->module->namespaces; ns; ns = ns->next)
            if (token_equal(ns->name, full)) token_fail(ctx, enumeration->name, "enum conflicts with namespace declaration");
        for (Global *member = enumeration->members; member; member = member->next) {
            member->type = (Type)(TY_ENUM + enumeration->symbol);
            for (Global *other = enumeration->members; other != member; other = other->next)
                if (token_equal(other->name, member->name)) token_fail(ctx, member->name, "duplicate enum member name");
        }
    }
    uint32_t struct_index = 0;
    for (Struct *record = ast->structs; record; record = record->next) {
        ctx->filename = record->module->path; record->symbol = struct_index++;
        if (!record->field_count) token_fail(ctx, record->name, "struct must have at least one scalar field");
        Token full = join_name(ctx, record->scope, record->name, "::");
        for (Struct *other = ast->structs; other != record; other = other->next)
            if (struct_named(other, record->module, full)) token_fail(ctx, record->name, "duplicate struct declaration");
        if (find_global(ast, record->module, full)) token_fail(ctx, record->name, "struct conflicts with module constant/static storage");
        for (Function *fn = ast->functions; fn; fn = fn->next)
            if (function_named(fn, record->module, full)) token_fail(ctx, record->name, "struct conflicts with function declaration");
        for (Namespace *ns = record->module->namespaces; ns; ns = ns->next)
            if (token_equal(ns->name, full)) token_fail(ctx, record->name, "struct conflicts with namespace declaration");
    }
    for (TypeAlias *alias = ast->aliases; alias; alias = alias->next) {
        ctx->filename = alias->module->path;
        Token full = join_name(ctx, alias->scope, alias->name, "::");
        for (TypeAlias *other = ast->aliases; other != alias; other = other->next)
            if (alias_named(other, alias->module, full)) token_fail(ctx, alias->name, "duplicate type alias declaration");
        if (find_global(ast, alias->module, full)) token_fail(ctx, alias->name, "type alias conflicts with module constant/static storage");
        if (find_struct(ast, alias->module, full)) token_fail(ctx, alias->name, "type alias conflicts with struct declaration");
        for (Function *fn = ast->functions; fn; fn = fn->next)
            if (function_named(fn, alias->module, full)) token_fail(ctx, alias->name, "type alias conflicts with function declaration");
        for (Namespace *ns = alias->module->namespaces; ns; ns = ns->next)
            if (token_equal(ns->name, full)) token_fail(ctx, alias->name, "type alias conflicts with namespace declaration");
    }
    uint32_t global_index = 0;
    for (Global *constant = ast->globals; constant; constant = constant->next) {
        ctx->filename = constant->module->path;
        if (constant->is_static) constant->symbol = global_index++;
        Token full = join_name(ctx, constant->scope, constant->name, "::");
        for (Global *other = ast->globals; other != constant; other = other->next)
            if (global_named(other, constant->module, full)) token_fail(ctx, constant->name, "duplicate module constant/static declaration");
        for (Function *fn = ast->functions; fn; fn = fn->next)
            if (function_named(fn, constant->module, full)) token_fail(ctx, constant->name, "module constant/static storage conflicts with function declaration");
        for (Namespace *ns = constant->module->namespaces; ns; ns = ns->next)
            if (token_equal(ns->name, full)) token_fail(ctx, constant->name, "module constant/static storage conflicts with namespace declaration");
    }
    for (Module *module = ast->modules; module; module = module->next) imports(ctx, ast, module);
    for (TypeAlias *alias = ast->aliases; alias; alias = alias->next) (void)resolve_alias(ctx, ast, alias, NULL);
    for (Struct *record = ast->structs; record; record = record->next) {
        ctx->filename = record->module->path;
        Function scope = {.module = record->module, .scope = record->scope};
        Semantic s = {.ctx = ctx, .ast = ast, .fn = &scope};
        for (Field *field = record->fields; field; field = field->next) {
            field->type = resolve_type(&s, field->type, field->type_name, NULL);
            if (field->type != TY_INT && field->type != TY_BOOL && field->type != TY_BYTE && field->type != TY_STRING && !IS_ENUM(field->type))
                token_fail(ctx, field->name, "struct fields must be scalar int or bool or byte or string or enum");
            if (record->exported) public_type(&s, field->name, field->type);
            for (Field *other = record->fields; other != field; other = other->next)
                if (token_equal(other->name, field->name)) token_fail(ctx, field->name, "duplicate struct field");
        }
    }
    for (Global *constant = ast->globals; constant; constant = constant->next) {
        ctx->filename = constant->module->path;
        Function scope = {.module = constant->module, .scope = constant->scope};
        Semantic s = {.ctx = ctx, .ast = ast, .fn = &scope};
        constant->type = resolve_type(&s, constant->type, constant->type_name, NULL);
        if (constant->length && constant->type != TY_INT && constant->type != TY_BOOL && constant->type != TY_BYTE)
            token_fail(ctx, constant->name, "static array element type must be int, bool or byte");
        if (constant->type != TY_INT && constant->type != TY_BOOL && constant->type != TY_BYTE && constant->type != TY_STRING && !IS_ENUM(constant->type))
            token_fail(ctx, constant->name, "module constant/static type must be explicit int or bool or byte or string or enum");
        if (constant->exported) public_type(&s, constant->name, constant->type);
    }
    bool main_found = false;
    for (Function *fn = ast->functions; fn; fn = fn->next) {
        ctx->filename = fn->module->path;
        Semantic s = {.ctx = ctx, .ast = ast, .fn = fn};
        fn->result = resolve_type(&s, fn->result, fn->result_name, NULL);
        if (fn->exported) public_type(&s, fn->name, fn->result);
        if (fn->result == TY_AUTO) token_fail(ctx, fn->name, "function return type must be explicit");
        Type parameters[L_MAX_SLOTS]; uint32_t count = 0;
        for (Decl *p = fn->parameters; p; p = p->next) {
            p->type = resolve_type(&s, p->type, p->type_name, NULL);
            if (fn->exported) public_type(&s, p->name, p->type);
            if (p->type == TY_VOID || p->type == TY_AUTO) token_fail(ctx, p->name, "parameter type must be int, bool, byte, string, enum or struct");
            else parameters[count++] = p->type;
            Binding *binding = allocate(ctx, sizeof(*binding));
            *binding = (Binding){p, 0, s.bindings}; s.bindings = binding;
        }
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
        check_intrinsic(ctx, fn);
    }
    if (!main_found) { ctx->filename = ast->entry->path; fail(ctx, 0, 0, "missing entry point int main()"); }
    for (Enum *enumeration = ast->enums; enumeration; enumeration = enumeration->next) {
        ctx->filename = enumeration->module->path;
        Function scope = {.module = enumeration->module, .scope = enumeration->scope};
        Semantic s = {.ctx = ctx, .ast = ast, .fn = &scope, .constant_expression = true};
        Global *previous = NULL;
        for (Global *member = enumeration->members; member; member = member->next) {
            if (member->value) require(&s, member->name, analyze_expr(&s, member->value), TY_INT);
            else {
                /* Internal increment only: user expressions cannot perform enum arithmetic. */
                Expr *value = allocate(ctx, sizeof(*value)); value->token = member->name; value->kind = EX_INT;
                if (previous) {
                    value->kind = EX_BINARY; value->op = '+';
                    value->left = allocate(ctx, sizeof(*value->left));
                    *value->left = (Expr){.kind = EX_NAME, .token = member->name, .global = previous};
                    value->right = allocate(ctx, sizeof(*value->right));
                    *value->right = (Expr){.kind = EX_INT, .token = member->name, .integer = 1};
                }
                member->value = value;
            }
            previous = member;
        }
    }
    for (Global *constant = ast->globals; constant; constant = constant->next) {
        ctx->filename = constant->module->path;
        Function scope = {.module = constant->module, .scope = constant->scope};
        Semantic s = {.ctx = ctx, .ast = ast, .fn = &scope, .reachable = true, .constant_expression = true};
        if (constant->length) require(&s, constant->name, analyze_expr(&s, constant->length), TY_INT);
        else require(&s, constant->name, analyze_expr(&s, constant->value), constant->type);
    }
    evaluate_constants(ctx, ast);
    uint32_t global_elements = 0;
    for (Global *global = ast->globals; global; global = global->next) {
        if (!global->length) continue;
        ctx->filename = global->module->path;
        int32_t length = evaluate_constant_expression(ctx, ast, global->length);
        if (length < 1 || length > (int32_t)L_MAX_ARRAY) token_fail(ctx, global->name, "static array length must be 1..65535");
        global->array = (uint32_t)length;
        if (global->array > L_MAX_GLOBAL_ELEMENTS - global_elements)
            token_fail(ctx, global->name, "too many static array elements (maximum 1048576)");
        global_elements += global->array;
    }
    for (Function *fn = ast->functions; fn; fn = fn->next) {
        ctx->filename = fn->module->path;
        Semantic s = { ctx, ast, fn, NULL, 0, 0, NULL, true, false };
        for (Decl *p = fn->parameters; p; p = p->next) bind(&s, p);
        if (fn->is_extern) continue; /* VM intrinsics have no L body to analyze. */
        /* Parameters and the outermost function block share one scope. */
        bool falls = analyze_sequence(&s, fn->body->body);
        if (falls && fn->result != TY_VOID) token_fail(ctx, fn->name, "not all control-flow paths return a value");
    }
    ctx->filename = saved;
}
