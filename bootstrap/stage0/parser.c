#include "l.h"

typedef struct { Context *ctx; Token *tokens; size_t at, count; } Parser;
static Token peek(Parser *p) { return p->tokens[p->at]; }
static bool take(Parser *p, int kind) {
    if (peek(p).kind != kind) return false;
    ++p->at;
    return true;
}
static Token expect(Parser *p, int kind, const char *message) {
    Token token = peek(p);
    if (!take(p, kind)) token_fail(p->ctx, token, message);
    return token;
}
static Token name_path(Parser *p, int separator) {
    Token name = expect(p, TK_NAME, "invalid module path or qualified name: expected identifier");
    while (take(p, separator)) {
        Token part = expect(p, TK_NAME, "invalid module path or qualified name: expected identifier after name separator");
        name = join_name(p->ctx, name, part, separator == '.' ? "." : "::");
    }
    return name;
}
static Type parse_type(Parser *p, Token *name) {
    Token token = peek(p);
    if (token.kind == TK_NAME) { *name = name_path(p, TK_SCOPE); return TY_NAMED; }
    ++p->at;
    switch (token.kind) {
    case TK_INT: return TY_INT;
    case TK_BOOL: return TY_BOOL;
    case TK_BYTE: return TY_BYTE;
    case TK_STRING: return TY_STRING;
    case TK_VOID: return TY_VOID;
    case TK_AUTO: return TY_AUTO;
    default: token_fail(p->ctx, token, "expected Stage 0 type (int, bool, byte, string, void, auto or named type)");
    }
}
static bool starts_decl(Parser *p) {
    int k = peek(p).kind;
    if (k == TK_INT || k == TK_BYTE) return p->tokens[p->at + 1].kind != '(';
    if (k == TK_CONST || k == TK_BOOL || k == TK_VOID || k == TK_AUTO || k == TK_STRING) return true;
    if (k != TK_NAME) return false;
    /* A qualified name followed by an identifier is a declaration, not a value expression. */
    size_t at = p->at + 1;
    while (p->tokens[at].kind == TK_SCOPE) {
        if (p->tokens[++at].kind != TK_NAME) return false;
        ++at;
    }
    return p->tokens[at].kind == TK_NAME;
}
static Expr *expression(Parser *, int);
static Stmt *statement(Parser *);
static Expr *new_expr(Parser *p, ExprKind kind, Token token) {
    Expr *e = allocate(p->ctx, sizeof(*e));
    e->kind = kind; e->token = token;
    return e;
}
static Stmt *new_stmt(Parser *p, StmtKind kind, Token token) {
    Stmt *s = allocate(p->ctx, sizeof(*s));
    s->kind = kind; s->token = token;
    return s;
}
static int precedence(int op) {
    switch (op) {
    case '=': return 1;
    case TK_OR: return 2;
    case TK_AND: return 3;
    case TK_EQ: case TK_NE: return 4;
    case '<': case '>': case TK_LE: case TK_GE: return 5;
    case '+': case '-': return 6;
    case '*': case '/': case '%': return 7;
    default: return 0;
    }
}
static Expr *primary(Parser *p) {
    Token token = peek(p);
    Expr *e;
    if (take(p, TK_TEXT)) {
        e = new_expr(p, EX_STRING, token);
    } else if (take(p, TK_INTEGER)) {
        e = new_expr(p, EX_INT, token); e->integer = token.integer;
    } else if (take(p, TK_TRUE) || take(p, TK_FALSE)) {
        e = new_expr(p, EX_BOOL, token); e->integer = token.kind == TK_TRUE;
    } else if (token.kind == TK_BYTE || token.kind == TK_INT) {
        ++p->at;
        e = new_expr(p, EX_CONVERT, token); e->type = token.kind == TK_BYTE ? TY_BYTE : TY_INT;
        expect(p, '(', "expected '(' after conversion type");
        e->left = expression(p, 1);
        expect(p, ')', "expected ')' after conversion operand");
    } else if (token.kind == TK_NAME) {
        e = new_expr(p, EX_NAME, name_path(p, TK_SCOPE));
    } else if (take(p, '(')) {
        e = expression(p, 1);
        expect(p, ')', "expected ')' after expression");
    } else if (token.kind == '-' || token.kind == '+' || token.kind == '!') {
        ++p->at;
        e = new_expr(p, EX_UNARY, token); e->op = token.kind;
        e->left = expression(p, 8);
        /* The only positive literal outside int range is legal directly under unary minus. */
        if (token.kind == '-' && e->left->kind == EX_INT && e->left->integer == INT64_C(2147483648)) {
            e->kind = EX_INT; e->integer = INT32_MIN; e->left = NULL;
        }
    } else token_fail(p->ctx, token, "expected expression");
    for (;;) {
        if (take(p, '(')) {
            Expr *call = new_expr(p, EX_CALL, e->token); call->left = e;
            ExprList **tail = &call->args;
            if (!take(p, ')')) {
                do {
                    ExprList *arg = allocate(p->ctx, sizeof(*arg));
                    arg->value = expression(p, 1); *tail = arg; tail = &arg->next;
                } while (take(p, ','));
                expect(p, ')', "expected ')' after arguments");
            }
            e = call;
        } else if (take(p, '{')) {
            Expr *value = new_expr(p, EX_STRUCT, e->token); value->left = e;
            ExprList **tail = &value->args;
            if (!take(p, '}')) {
                do {
                    ExprList *arg = allocate(p->ctx, sizeof(*arg));
                    arg->value = expression(p, 1); *tail = arg; tail = &arg->next;
                    if (!take(p, ',')) break;
                    if (peek(p).kind == '}') break;
                } while (true);
                expect(p, '}', "expected '}' after struct literal");
            }
            e = value;
        } else if (take(p, '.')) {
            Expr *field = new_expr(p, EX_FIELD, expect(p, TK_NAME, "expected field name after '.'"));
            field->left = e; e = field;
        } else if (take(p, '[')) {
            Expr *index = new_expr(p, EX_INDEX, e->token);
            index->left = e; index->right = expression(p, 1);
            expect(p, ']', "expected ']' after array index");
            e = index;
        } else if (peek(p).kind == TK_INC || peek(p).kind == TK_DEC) {
            Token op = p->tokens[p->at++];
            Expr *post = new_expr(p, EX_POSTFIX, op); post->op = op.kind; post->left = e; e = post;
        } else break;
    }
    return e;
}
static Expr *expression(Parser *p, int minimum) {
    enter(p->ctx, peek(p));
    Expr *left = primary(p);
    for (;;) {
        Token op = peek(p);
        int prec = precedence(op.kind);
        if (prec < minimum) break;
        ++p->at;
        Expr *e = new_expr(p, op.kind == '=' ? EX_ASSIGN : EX_BINARY, op);
        e->op = op.kind; e->left = left;
        e->right = expression(p, prec + (op.kind != '='));
        left = e;
    }
    leave(p->ctx);
    return left;
}
static Decl *declaration(Parser *p, bool parameter) {
    Decl *decl = allocate(p->ctx, sizeof(*decl));
    decl->immutable = take(p, TK_CONST);
    decl->type = parse_type(p, &decl->type_name);
    decl->name = expect(p, TK_NAME, "expected variable name");
    if (take(p, '[')) {
        decl->length = expression(p, 1);
        expect(p, ']', "expected ']' after array length");
        if (parameter) token_fail(p->ctx, decl->name, "arrays are not supported as parameters");
    }
    if (!parameter) {
        if (decl->length) {
            if (peek(p).kind == '=') token_fail(p->ctx, peek(p), "arrays initialize to zero and cannot have an initializer");
            expect(p, ';', "expected ';' after array declaration");
        } else {
            expect(p, '=', "Stage 0 local declarations require an initializer");
            decl->value = expression(p, 1);
            expect(p, ';', "expected ';' after declaration");
        }
    }
    return decl;
}
static Expr *condition(Parser *p) {
    expect(p, '(', "expected '(' before condition");
    Expr *e = expression(p, 1);
    expect(p, ')', "expected ')' after condition");
    return e;
}
static Stmt *statement(Parser *p) {
    Token token = peek(p);
    enter(p->ctx, token);
    Stmt *s;
    if (take(p, '{')) {
        s = new_stmt(p, ST_BLOCK, token);
        Stmt **tail = &s->body;
        while (!take(p, '}')) {
            if (peek(p).kind == TK_EOF) token_fail(p->ctx, peek(p), "expected '}' before end of file");
            *tail = statement(p); tail = &(*tail)->next;
        }
    } else if (take(p, TK_IF)) {
        s = new_stmt(p, ST_IF, token); s->condition = condition(p); s->body = statement(p);
        if (take(p, TK_ELSE)) s->other = statement(p);
    } else if (take(p, TK_WHILE)) {
        s = new_stmt(p, ST_WHILE, token); s->condition = condition(p); s->body = statement(p);
    } else if (take(p, TK_FOR)) {
        s = new_stmt(p, ST_FOR, token);
        expect(p, '(', "expected '(' after for");
        if (starts_decl(p)) {
            s->init = new_stmt(p, ST_DECL, peek(p)); s->init->decl = declaration(p, false);
        } else if (!take(p, ';')) {
            s->init = new_stmt(p, ST_EXPR, peek(p)); s->init->expr = expression(p, 1);
            expect(p, ';', "expected ';' after for initializer");
        }
        if (!take(p, ';')) {
            s->condition = expression(p, 1); expect(p, ';', "expected ';' after for condition");
        }
        if (!take(p, ')')) {
            s->step = expression(p, 1); expect(p, ')', "expected ')' after for step");
        }
        s->body = statement(p);
    } else if (take(p, TK_RETURN)) {
        s = new_stmt(p, ST_RETURN, token);
        if (!take(p, ';')) { s->expr = expression(p, 1); expect(p, ';', "expected ';' after return"); }
    } else if (token.kind == TK_BREAK || token.kind == TK_CONTINUE) {
        ++p->at;
        s = new_stmt(p, token.kind == TK_BREAK ? ST_BREAK : ST_CONTINUE, token);
        expect(p, ';', "expected ';' after loop control statement");
    } else if (take(p, TK_SWITCH)) {
        s = new_stmt(p, ST_SWITCH, token);
        s->expr = condition(p);
        expect(p, '{', "expected '{' after switch condition");
        SwitchCase **tail = &s->cases;
        while (!take(p, '}')) {
            if (peek(p).kind == TK_EOF) token_fail(p->ctx, peek(p), "expected '}' before end of file");
            SwitchCase *label = allocate(p->ctx, sizeof(*label));
            label->token = peek(p);
            if (take(p, TK_CASE)) {
                label->expr = expression(p, 1);
                expect(p, ':', "expected ':' after case value");
            } else if (take(p, TK_DEFAULT)) {
                label->is_default = true;
                expect(p, ':', "expected ':' after default");
            } else token_fail(p->ctx, peek(p), "expected case or default label");
            Stmt **body = &label->body;
            while (peek(p).kind != TK_CASE && peek(p).kind != TK_DEFAULT && peek(p).kind != '}') {
                if (peek(p).kind == TK_EOF) token_fail(p->ctx, peek(p), "expected '}' before end of file");
                *body = statement(p); body = &(*body)->next;
            }
            *tail = label; tail = &label->next;
        }
    } else if (token.kind == TK_CASE || token.kind == TK_DEFAULT)
        token_fail(p->ctx, token, "case/default requires an enclosing switch body");
    else if (starts_decl(p)) {
        s = new_stmt(p, ST_DECL, token); s->decl = declaration(p, false);
    } else if (take(p, ';')) s = new_stmt(p, ST_EMPTY, token);
    else {
        s = new_stmt(p, ST_EXPR, token); s->expr = expression(p, 1);
        expect(p, ';', "expected ';' after expression");
    }
    leave(p->ctx);
    return s;
}

static void declarations(Parser *p, Ast *ast, Token scope, bool nested) {
    Function **tail = &ast->functions;
    while (*tail) tail = &(*tail)->next;
    while (peek(p).kind != TK_EOF && peek(p).kind != '}') {
        Token token = peek(p);
        bool exported = take(p, TK_PUB);
        if (take(p, TK_NAMESPACE)) {
            if (exported) token_fail(p->ctx, token, "namespaces do not change declaration visibility");
            Token name = expect(p, TK_NAME, "expected namespace name");
            name = join_name(p->ctx, scope, name, "::");
            Namespace *ns = allocate(p->ctx, sizeof(*ns)); ns->name = name;
            ns->next = ast->entry->namespaces; ast->entry->namespaces = ns;
            expect(p, '{', "expected '{' after namespace name");
            enter(p->ctx, token); declarations(p, ast, name, true); leave(p->ctx);
            while (*tail) tail = &(*tail)->next;
            continue;
        }
        if (peek(p).kind == TK_MODULE || peek(p).kind == TK_IMPORT)
            token_fail(p->ctx, peek(p), "module and import declarations must precede other declarations");
        if (take(p, TK_ENUM)) {
            if (ast->enum_count++ == L_MAX_ENUMS) token_fail(p->ctx, token, "too many enums (maximum 256)");
            Enum *enumeration = allocate(p->ctx, sizeof(*enumeration));
            enumeration->module = ast->entry; enumeration->scope = scope; enumeration->exported = exported;
            enumeration->name = expect(p, TK_NAME, "expected enum name");
            expect(p, '{', "expected '{' after enum name");
            Global **members = &enumeration->members;
            if (!take(p, '}')) {
                do {
                    if (enumeration->member_count++ == L_MAX_MEMBERS) token_fail(p->ctx, peek(p), "too many enum members (maximum 1024)");
                    Global *member = allocate(p->ctx, sizeof(*member));
                    member->name = expect(p, TK_NAME, "expected enum member name");
                    member->module = ast->entry; member->exported = exported;
                    member->scope = join_name(p->ctx, scope, enumeration->name, "::");
                    if (take(p, '=')) member->value = expression(p, 1);
                    *members = member; members = &member->next;
                    if (!take(p, ',')) break;
                    if (peek(p).kind == '}') break;
                } while (true);
                expect(p, '}', "expected '}' after enum members");
            }
            expect(p, ';', "expected ';' after enum declaration");
            Enum **enums = &ast->enums;
            while (*enums) enums = &(*enums)->next;
            *enums = enumeration;
            continue;
        }
        if (take(p, TK_STRUCT)) {
            if (ast->struct_count++ == L_MAX_STRUCTS) token_fail(p->ctx, token, "too many structs (maximum 256)");
            Struct *record = allocate(p->ctx, sizeof(*record));
            record->module = ast->entry; record->scope = scope; record->exported = exported;
            record->name = expect(p, TK_NAME, "expected struct name");
            expect(p, '{', "expected '{' after struct name");
            Field **fields = &record->fields;
            while (!take(p, '}')) {
                if (record->field_count++ == L_MAX_FIELDS) token_fail(p->ctx, peek(p), "too many struct fields (maximum 64)");
                Field *field = allocate(p->ctx, sizeof(*field));
                field->type = parse_type(p, &field->type_name);
                field->name = expect(p, TK_NAME, "expected struct field name");
                expect(p, ';', "expected ';' after scalar struct field");
                *fields = field; fields = &field->next;
            }
            expect(p, ';', "expected ';' after struct declaration");
            Struct **records = &ast->structs;
            while (*records) records = &(*records)->next;
            *records = record;
            continue;
        }
        if (take(p, TK_USING)) {
            if (ast->alias_count++ == L_MAX_ALIASES) token_fail(p->ctx, token, "too many type aliases (maximum 1024)");
            TypeAlias *alias = allocate(p->ctx, sizeof(*alias));
            alias->module = ast->entry; alias->scope = scope; alias->exported = exported;
            alias->name = expect(p, TK_NAME, "expected type alias name");
            expect(p, '=', "expected '=' after type alias name");
            alias->type = parse_type(p, &alias->target_name);
            expect(p, ';', "expected ';' after type alias");
            TypeAlias **aliases = &ast->aliases;
            while (*aliases) aliases = &(*aliases)->next;
            *aliases = alias;
            continue;
        }
        bool is_static = take(p, TK_STATIC);
        if (is_static || take(p, TK_CONST)) {
            if (is_static) {
                if (ast->static_count++ == L_MAX_GLOBALS) token_fail(p->ctx, token, "too many static globals (maximum 1024)");
            } else if (ast->constant_count++ == L_MAX_CONSTANTS) token_fail(p->ctx, token, "too many module constants (maximum 1024)");
            Global *constant = allocate(p->ctx, sizeof(*constant));
            constant->module = ast->entry; constant->scope = scope; constant->exported = exported;
            constant->is_static = is_static;
            constant->type = parse_type(p, &constant->type_name);
            constant->name = expect(p, TK_NAME, is_static ? "expected static storage name" : "expected module constant name");
            expect(p, '=', is_static ? "static storage requires a scalar constant initializer" : "module constants require a scalar initializer");
            constant->value = expression(p, 1);
            expect(p, ';', is_static ? "expected ';' after static declaration" : "expected ';' after module constant");
            Global **constants = &ast->globals;
            while (*constants) constants = &(*constants)->next;
            *constants = constant;
            continue;
        }
        bool is_extern = take(p, TK_EXTERN);
        if (ast->function_count++ >= L_MAX_FUNCTIONS) token_fail(p->ctx, peek(p), "too many functions (maximum 256)");
        Function *fn = allocate(p->ctx, sizeof(*fn));
        fn->module = ast->entry; fn->scope = scope; fn->exported = exported;
        fn->is_extern = is_extern;
        fn->result = parse_type(p, &fn->result_name);
        fn->name = expect(p, TK_NAME, "expected function name");
        expect(p, '(', "expected '(' after function name");
        Decl **param = &fn->parameters;
        if (!take(p, ')')) {
            do {
                if (++fn->parameter_count > L_MAX_SLOTS) token_fail(p->ctx, peek(p), "too many parameters");
                *param = declaration(p, true); param = &(*param)->next;
            } while (take(p, ','));
            expect(p, ')', "expected ')' after parameters");
        }
        if (is_extern) expect(p, ';', "expected ';' after extern declaration");
        else if (peek(p).kind != '{') token_fail(p->ctx, peek(p), "expected function body");
        if (!is_extern) fn->body = statement(p);
        *tail = fn; tail = &fn->next;
    }
    if (nested) expect(p, '}', "expected '}' after namespace");
    else expect(p, TK_EOF, "unexpected '}' at module scope");
}
Ast *parse(Context *ctx, Token *tokens, size_t count) {
    Parser p = { ctx, tokens, 0, count };
    Ast *ast = allocate(ctx, sizeof(*ast));
    ast->entry = ast->modules = allocate(ctx, sizeof(*ast->entry));
    ast->entry->path = ctx->filename; ast->entry->package = "";
    expect(&p, TK_MODULE, "each source file must begin with exactly one module declaration");
    ast->entry->name = name_path(&p, '.');
    ast->entry->qualifier = namespace_path(ctx, ast->entry->name);
    expect(&p, ';', "expected ';' after module declaration");
    Import **tail = &ast->entry->imports;
    uint32_t imports = 0;
    while (take(&p, TK_IMPORT)) {
        if (++imports > L_MAX_IMPORTS) token_fail(ctx, peek(&p), "too many imports");
        Import *item = allocate(ctx, sizeof(*item));
        item->name = name_path(&p, '.');
        item->qualifier = namespace_path(ctx, item->name);
        if (take(&p, TK_AS)) item->alias = expect(&p, TK_NAME, "expected module alias");
        else if (take(&p, TK_SCOPE)) {
            expect(&p, '{', "selective imports require '{'; wildcard imports are not supported");
            ImportName **names = &item->names;
            do {
                ImportName *name = allocate(ctx, sizeof(*name));
                name->name = name_path(&p, TK_SCOPE); name->binding = leaf_name(name->name);
                if (take(&p, TK_AS)) name->binding = expect(&p, TK_NAME, "expected selective import alias");
                *names = name; names = &name->next;
                if (!take(&p, ',')) break;
                if (peek(&p).kind == '}') break;
            } while (true);
            expect(&p, '}', "expected '}' after selective imports");
        }
        expect(&p, ';', "expected ';' after import");
        *tail = item; tail = &item->next;
    }
    declarations(&p, ast, (Token){.text = ""}, false);
    ast->entry->functions = ast->functions;
    ast->entry->globals = ast->globals;
    ast->entry->aliases = ast->aliases;
    ast->entry->structs = ast->structs;
    ast->entry->enums = ast->enums;
    return ast;
}
