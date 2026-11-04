#include "l.h"

static int32_t constant_value(Context *, Global *, Global *);
static int32_t checked_constant(Context *ctx, Token token, int64_t value) {
    if (value < INT32_MIN || value > INT32_MAX) token_fail(ctx, token, "invalid constant expression: integer overflow");
    return (int32_t)value;
}
static int32_t expression_value(Context *ctx, Expr *e, Global *owner) {
    enter(ctx, e->token);
    int32_t value;
    switch (e->kind) {
    case EX_INT: case EX_BOOL: value = (int32_t)e->integer; break;
    case EX_NAME: value = constant_value(ctx, e->global, owner); break;
    case EX_CONVERT:
        value = expression_value(ctx, e->left, owner);
        if (e->type == TY_BYTE && (uint32_t)value > 255) token_fail(ctx, e->token, "invalid constant expression: byte conversion out of range (0..255)");
        break;
    case EX_UNARY: {
        int32_t a = expression_value(ctx, e->left, owner);
        switch (e->op) {
        case '+': value = a; break;
        case '-': value = checked_constant(ctx, e->token, -(int64_t)a); break;
        case '!': value = !a; break;
        default: token_fail(ctx, e->token, "invalid constant unary operator");
        }
        break;
    }
    case EX_BINARY: {
        int32_t a = expression_value(ctx, e->left, owner);
        if (e->op == TK_AND && !a) { value = 0; break; }
        if (e->op == TK_OR && a) { value = 1; break; }
        int32_t b = expression_value(ctx, e->right, owner);
        switch (e->op) {
        case '+': value = checked_constant(ctx, e->token, (int64_t)a + b); break;
        case '-': value = checked_constant(ctx, e->token, (int64_t)a - b); break;
        case '*': value = checked_constant(ctx, e->token, (int64_t)a * b); break;
        case '/': case '%':
            if (!b) token_fail(ctx, e->token, "invalid constant expression: division by zero");
            if (a == INT32_MIN && b == -1) token_fail(ctx, e->token, "invalid constant expression: integer overflow");
            value = (int32_t)(e->op == '/' ? (int64_t)a / b : (int64_t)a % b); break;
        case TK_EQ: value = a == b; break;
        case TK_NE: value = a != b; break;
        case '<': value = a < b; break;
        case TK_LE: value = a <= b; break;
        case '>': value = a > b; break;
        case TK_GE: value = a >= b; break;
        case TK_AND: case TK_OR: value = b; break;
        default: token_fail(ctx, e->token, "invalid constant binary operator");
        }
        break;
    }
    default: token_fail(ctx, e->token, "invalid AST expression during constant evaluation");
    }
    leave(ctx);
    return value;
}
static Token constant_name(Context *ctx, const Global *constant) {
    Token name = join_name(ctx, constant->scope, constant->name, "::");
    return join_name(ctx, constant->module->qualifier, name, "::");
}
static int32_t constant_value(Context *ctx, Global *constant, Global *parent) {
    if (constant->state == 2) return constant->integer;
    const char *saved = ctx->filename; ctx->filename = constant->module->path;
    if (constant->state == 1) {
        Global *path[L_MAX_DEPTH]; unsigned count = 0;
        for (Global *node = parent; node != constant; node = node->parent) path[count++] = node;
        Token trace = constant_name(ctx, constant);
        while (count) trace = join_name(ctx, trace, constant_name(ctx, path[--count]), " -> ");
        trace = join_name(ctx, trace, constant_name(ctx, constant), " -> ");
        fail(ctx, constant->name.line, constant->name.column, "constant dependency cycle detected: %.*s", (int)trace.length, trace.text);
    }
    enter(ctx, constant->name);
    constant->state = 1; constant->parent = parent;
    constant->integer = expression_value(ctx, constant->value, constant);
    constant->state = 2; constant->parent = NULL;
    leave(ctx); ctx->filename = saved;
    return constant->integer;
}
void evaluate_constants(Context *ctx, Ast *ast) {
    for (Enum *enumeration = ast->enums; enumeration; enumeration = enumeration->next)
        for (Global *member = enumeration->members; member; member = member->next) (void)constant_value(ctx, member, NULL);
    for (Global *constant = ast->globals; constant; constant = constant->next) (void)constant_value(ctx, constant, NULL);
}
int32_t evaluate_constant_expression(Context *ctx, Expr *expr) { return expression_value(ctx, expr, NULL); }
