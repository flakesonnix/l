#include "l.h"

#include <string.h>

typedef struct Binding Binding;
struct Binding { Decl *decl; unsigned depth; Binding *next; };
typedef struct Enclosing Enclosing;
struct Enclosing { bool is_loop; unsigned breaks; Enclosing *parent; };
typedef struct { Context *ctx; Ast *ast; Function *fn; Binding *bindings; unsigned depth; uint32_t elements; Enclosing *enclosing; bool reachable; } Semantic;
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
        if (!b) token_fail(s->ctx, e->token, "unknown local variable");
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
        if (!b) token_fail(s->ctx, e->token, "unknown local variable");
        if (b->decl->array) token_fail(s->ctx, e->token, "array used without an index");
        e->symbol = b->decl->slot; e->type = b->decl->type; break;
    }
    case EX_INDEX:
        (void)resolve_index(s, e); break;
    case EX_ASSIGN: {
        Decl *d = lvalue(s, e->left);
        require(s, e->token, analyze_expr(s, e->right), d->type);
        e->type = d->type; break;
    }
    case EX_POSTFIX:
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
        if (e->left->kind != EX_NAME) token_fail(s->ctx, e->token, "Stage 0 supports direct function calls only");
        if (lookup(s, e->left->token)) token_fail(s->ctx, e->token, "local binding is not callable");
        Function *fn = s->ast->functions;
        uint32_t index = 0;
        while (fn && !token_equal(fn->name, e->left->token)) { fn = fn->next; ++index; }
        if (!fn) token_fail(s->ctx, e->token, "unknown function");
        e->symbol = index;
        Decl *param = fn->parameters;
        ExprList *arg = e->args;
        for (; param && arg; param = param->next, arg = arg->next)
            require(s, arg->value->token, analyze_expr(s, arg->value), param->type);
        if (param || arg) token_fail(s->ctx, e->token, "wrong number of function arguments");
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

void analyze(Context *ctx, Ast *ast) {
    bool main_found = false;
    for (Function *fn = ast->functions; fn; fn = fn->next) {
        if (fn->result == TY_AUTO) token_fail(ctx, fn->name, "function return type must be explicit");
        for (Function *other = ast->functions; other != fn; other = other->next)
            if (token_equal(fn->name, other->name)) token_fail(ctx, fn->name, "duplicate function declaration");
        for (Decl *p = fn->parameters; p; p = p->next)
            if (p->type == TY_VOID || p->type == TY_AUTO) token_fail(ctx, p->name, "parameter type must be int or bool");
        if (fn->name.length == 4 && !memcmp(fn->name.text, "main", 4)) {
            main_found = true;
            if (fn->result != TY_INT || fn->parameter_count) token_fail(ctx, fn->name, "entry point must have signature int main()");
        }
    }
    if (!main_found) fail(ctx, 0, 0, "missing entry point int main()");
    for (Function *fn = ast->functions; fn; fn = fn->next) {
        Semantic s = { ctx, ast, fn, NULL, 0, 0, NULL, true };
        for (Decl *p = fn->parameters; p; p = p->next) bind(&s, p);
        /* Parameters and the outermost function block share one scope. */
        bool falls = analyze_sequence(&s, fn->body->body);
        if (falls && fn->result != TY_VOID) token_fail(ctx, fn->name, "not all control-flow paths return a value");
    }
}
