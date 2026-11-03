#include "l.h"

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

struct Allocation { Allocation *next; size_t size; max_align_t alignment; };

_Noreturn void fail(Context *ctx, uint32_t line, uint32_t column, const char *format, ...) {
    fprintf(stderr, "%s", ctx->filename ? ctx->filename : "l");
    if (line) fprintf(stderr, ":%u:%u", line, column);
    fputs(": error: ", stderr);
    va_list args;
    va_start(args, format);
    vfprintf(stderr, format, args);
    va_end(args);
    fputc('\n', stderr);
    if (!ctx->status) ctx->status = 65;
    longjmp(ctx->failure, 1);
}

_Noreturn void token_fail(Context *ctx, Token token, const char *message) {
    fail(ctx, token.line, token.column, "%s", message);
}

void *allocate(Context *ctx, size_t size) {
    const size_t limit = 128u * 1024u * 1024u;
    if (size > limit || ctx->allocated > limit - size)
        fail(ctx, 0, 0, "compiler/VM memory limit exceeded (128 MiB)");
    Allocation *item = calloc(1, sizeof(*item) + size);
    if (!item) fail(ctx, 0, 0, "out of memory");
    item->size = size;
    item->next = ctx->allocations;
    ctx->allocations = item;
    ctx->allocated += size;
    return item + 1;
}

void release(Context *ctx, void *ptr) {
    if (!ptr) return;
    Allocation *item = (Allocation *)ptr - 1;
    Allocation **link = &ctx->allocations;
    while (*link != item) link = &(*link)->next;
    *link = item->next;
    ctx->allocated -= item->size;
    free(item);
}

void cleanup(Context *ctx) {
    while (ctx->allocations) release(ctx, ctx->allocations + 1);
}

void reserve(Context *ctx, void **data, size_t *capacity, size_t needed, size_t size) {
    if (needed <= *capacity) return;
    size_t next = *capacity ? *capacity * 2 : 16;
    while (next < needed) {
        if (next > SIZE_MAX / 2) fail(ctx, 0, 0, "container size overflow");
        next *= 2;
    }
    if (next > SIZE_MAX / size) fail(ctx, 0, 0, "container size overflow");
    void *replacement = allocate(ctx, next * size);
    if (*data) memcpy(replacement, *data, *capacity * size);
    release(ctx, *data);
    *data = replacement;
    *capacity = next;
}

char *copy_text(Context *ctx, const char *text, size_t size) {
    char *result = allocate(ctx, size + 1);
    memcpy(result, text, size);
    return result;
}

bool token_equal(Token a, Token b) {
    return a.length == b.length && !memcmp(a.text, b.text, a.length);
}

const char *type_name(Type type) {
    switch (type) {
    case TY_VOID: return "void";
    case TY_INT: return "int";
    case TY_BOOL: return "bool";
    case TY_AUTO: return "auto";
    }
    return "invalid";
}

void enter(Context *ctx, Token token) {
    if (++ctx->nesting > L_MAX_DEPTH) token_fail(ctx, token, "syntax nesting limit exceeded (256)");
}

void leave(Context *ctx) { --ctx->nesting; }

unsigned char *read_file(Context *ctx, const char *path, size_t *size) {
    FILE *file = fopen(path, "rb");
    if (!file) { ctx->status = 74; fail(ctx, 0, 0, "cannot open input file"); }
    size_t capacity = 4096, length = 0;
    unsigned char *bytes = allocate(ctx, capacity + 1);
    for (;;) {
        size_t got = fread(bytes + length, 1, capacity - length, file);
        length += got;
        if (ferror(file)) { fclose(file); ctx->status = 74; fail(ctx, 0, 0, "cannot read input file"); }
        if (feof(file)) break;
        if (capacity >= 16u * 1024u * 1024u) { fclose(file); fail(ctx, 0, 0, "input exceeds 16 MiB limit"); }
        size_t next = capacity * 2;
        unsigned char *larger = allocate(ctx, next + 1);
        memcpy(larger, bytes, length);
        release(ctx, bytes);
        bytes = larger;
        capacity = next;
    }
    fclose(file);
    bytes[length] = 0;
    *size = length;
    return bytes;
}
