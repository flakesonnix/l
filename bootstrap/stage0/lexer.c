#include "l.h"

#include <string.h>

static bool digit(unsigned char c) { return c >= '0' && c <= '9'; }
static bool alpha(unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}

static int keyword(Token token) {
    static const struct { const char *name; int kind; } keywords[] = {
        {"int", TK_INT}, {"bool", TK_BOOL}, {"void", TK_VOID}, {"auto", TK_AUTO},
        {"const", TK_CONST}, {"true", TK_TRUE}, {"false", TK_FALSE},
        {"if", TK_IF}, {"else", TK_ELSE}, {"while", TK_WHILE}, {"for", TK_FOR},
        {"return", TK_RETURN}, {"module", TK_MODULE},
        {"break", TK_BREAK}, {"continue", TK_CONTINUE}
    };
    for (size_t i = 0; i < sizeof(keywords) / sizeof(*keywords); ++i)
        if (strlen(keywords[i].name) == token.length &&
            !memcmp(keywords[i].name, token.text, token.length)) return keywords[i].kind;
    return TK_NAME;
}

Token *lex(Context *ctx, const char *source, size_t length, size_t *count) {
    Token *tokens = NULL;
    size_t capacity = 0, at = 0;
    uint32_t line = 1, column = 1;
    *count = 0;
    while (at < length) {
        unsigned char c = (unsigned char)source[at];
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            ++at;
            if (c == '\n') { ++line; column = 1; } else ++column;
            continue;
        }
        Token token = { source + at, 1, line, column, c, 0 };
        if (c == '/' && at + 1 < length && source[at + 1] == '/') {
            while (at < length && source[at] != '\n') {
                if (!source[at]) token_fail(ctx, token, "NUL byte in source");
                ++at; ++column;
            }
            continue;
        }
        if (c == '/' && at + 1 < length && source[at + 1] == '*') {
            at += 2; column += 2;
            while (at + 1 < length && !(source[at] == '*' && source[at + 1] == '/')) {
                if (!source[at]) token_fail(ctx, token, "NUL byte in source");
                if (source[at++] == '\n') { ++line; column = 1; } else ++column;
            }
            if (at + 1 >= length) token_fail(ctx, token, "unterminated block comment");
            at += 2; column += 2;
            continue;
        }
        if (alpha(c)) {
            size_t start = at++;
            while (at < length && (alpha((unsigned char)source[at]) || digit((unsigned char)source[at]))) ++at;
            token.length = at - start;
            token.kind = keyword(token);
        } else if (digit(c)) {
            size_t start = at;
            while (at < length && digit((unsigned char)source[at])) {
                token.integer = token.integer * 10 + source[at++] - '0';
                if (token.integer > INT64_C(2147483648)) token_fail(ctx, token, "integer literal exceeds int range");
            }
            token.length = at - start;
            token.kind = TK_INTEGER;
            if (at < length && alpha((unsigned char)source[at])) token_fail(ctx, token, "invalid integer literal");
        } else {
            ++at;
            if (at < length) {
                char next = source[at];
                if (c == '=' && next == '=') token.kind = TK_EQ;
                else if (c == '!' && next == '=') token.kind = TK_NE;
                else if (c == '<' && next == '=') token.kind = TK_LE;
                else if (c == '>' && next == '=') token.kind = TK_GE;
                else if (c == '&' && next == '&') token.kind = TK_AND;
                else if (c == '|' && next == '|') token.kind = TK_OR;
                else if (c == '+' && next == '+') token.kind = TK_INC;
                else if (c == '-' && next == '-') token.kind = TK_DEC;
                if (token.kind >= TK_EQ) { ++at; token.length = 2; }
            }
            if (token.kind < 256 && !strchr("{}()[];,.+-*/%!<>=", c))
                token_fail(ctx, token, "unsupported character in Stage 0 source");
            if (!c) token_fail(ctx, token, "NUL byte in source");
        }
        column += (uint32_t)token.length;
        reserve(ctx, (void **)&tokens, &capacity, *count + 1, sizeof(*tokens));
        tokens[(*count)++] = token;
    }
    reserve(ctx, (void **)&tokens, &capacity, *count + 1, sizeof(*tokens));
    tokens[(*count)++] = (Token){ source + length, 0, line, column, TK_EOF, 0 };
    return tokens;
}
