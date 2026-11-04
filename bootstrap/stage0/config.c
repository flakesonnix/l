#define _XOPEN_SOURCE 700
#include "l.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

typedef struct { Context *ctx; const unsigned char *text; size_t at, size; } Json;
static _Noreturn void config_error(Json *j, const char *message) { fail(j->ctx, 0, 0, "invalid module manifest: %s", message); }
static void json_space(Json *j) {
    while (j->at < j->size && strchr(" \t\r\n", j->text[j->at]) && j->text[j->at]) ++j->at;
}
static bool json_take(Json *j, unsigned char c) {
    json_space(j);
    if (j->at == j->size || j->text[j->at] != c) return false;
    ++j->at; return true;
}
static void json_expect(Json *j, unsigned char c) {
    if (!json_take(j, c)) config_error(j, "unexpected token or end of file");
}
static uint32_t unicode_unit(Json *j) {
    if (j->size - j->at < 4) config_error(j, "truncated Unicode escape");
    uint32_t value = 0;
    for (unsigned n = 0; n < 4; ++n) {
        unsigned char c = j->text[j->at++];
        unsigned digit;
        if (c >= '0' && c <= '9') digit = c - '0';
        else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
        else config_error(j, "invalid Unicode escape");
        value = value * 16 + digit;
    }
    return value;
}
static void utf8(Json *j, unsigned char lead, char *value, size_t *length) {
    unsigned count;
    if (lead >= 0xc2 && lead <= 0xdf) count = 1;
    else if (lead >= 0xe0 && lead <= 0xef) count = 2;
    else if (lead >= 0xf0 && lead <= 0xf4) count = 3;
    else config_error(j, "invalid UTF-8 leading byte");
    if (j->size - j->at < count) config_error(j, "truncated UTF-8 sequence");
    unsigned char first = j->text[j->at];
    if ((lead == 0xe0 && first < 0xa0) || (lead == 0xed && first >= 0xa0) ||
        (lead == 0xf0 && first < 0x90) || (lead == 0xf4 && first >= 0x90))
        config_error(j, "invalid UTF-8 scalar value");
    value[(*length)++] = (char)lead;
    for (unsigned n = 0; n < count; ++n) {
        unsigned char c = j->text[j->at++];
        if (c < 0x80 || c > 0xbf) config_error(j, "invalid UTF-8 continuation byte");
        value[(*length)++] = (char)c;
    }
}
static char *json_string(Json *j) {
    json_expect(j, '"');
    char *value = NULL;
    size_t length = 0, capacity = 0;
    while (j->at < j->size) {
        reserve(j->ctx, (void **)&value, &capacity, length + 5, 1);
        unsigned char c = j->text[j->at++];
        if (c == '"') return value;
        if (c < 32) config_error(j, "control character in string");
        if (c >= 0x80) { utf8(j, c, value, &length); continue; }
        if (c != '\\') { value[length++] = (char)c; continue; }
        if (j->at == j->size) config_error(j, "truncated string escape");
        c = j->text[j->at++];
        switch (c) {
        case '"': case '\\': case '/': value[length++] = (char)c; break;
        case 'b': value[length++] = '\b'; break;
        case 'f': value[length++] = '\f'; break;
        case 'n': value[length++] = '\n'; break;
        case 'r': value[length++] = '\r'; break;
        case 't': value[length++] = '\t'; break;
        case 'u': {
            uint32_t code = unicode_unit(j);
            if (code >= 0xd800 && code <= 0xdbff) {
                if (j->size - j->at < 2 || j->text[j->at] != '\\' || j->text[j->at + 1] != 'u')
                    config_error(j, "missing low surrogate");
                j->at += 2;
                uint32_t low = unicode_unit(j);
                if (low < 0xdc00 || low > 0xdfff) config_error(j, "invalid low surrogate");
                code = 0x10000 + (code - 0xd800) * 1024 + low - 0xdc00;
            } else if (code >= 0xdc00 && code <= 0xdfff) config_error(j, "unexpected low surrogate");
            if (!code) config_error(j, "NUL in string");
            if (code < 0x80) value[length++] = (char)code;
            else {
                if (code >= 0x10000) value[length++] = (char)(0xf0 | (code >> 18));
                if (code >= 0x800) value[length++] = (char)((code < 0x10000 ? 0xe0 : 0x80) | ((code >> 12) & 63));
                value[length++] = (char)((code < 0x800 ? 0xc0 : 0x80) | ((code >> 6) & 63));
                value[length++] = (char)(0x80 | (code & 63));
            }
            break;
        }
        default: config_error(j, "invalid string escape");
        }
    }
    config_error(j, "unterminated string");
}
static bool identifier(const char *name) {
    if (!((*name >= 'a' && *name <= 'z') || (*name >= 'A' && *name <= 'Z') || *name == '_')) return false;
    for (++name; *name; ++name)
        if (!((*name >= 'a' && *name <= 'z') || (*name >= 'A' && *name <= 'Z') ||
              (*name >= '0' && *name <= '9') || *name == '_' || *name == '-')) return false;
    return true;
}
static void package_name(Json *j, const char *name) {
    if (!identifier(name)) config_error(j, "invalid package identity");
}
static Token module_prefix(Json *j, char *text) {
    Token prefix = {.text = text, .length = strlen(text)};
    if (!*text) return prefix; /* An explicitly registered empty prefix maps a whole source root. */
    size_t count; Token *tokens = lex(j->ctx, text, strlen(text), &count);
    for (size_t n = 0; n + 1 < count; ++n)
        if (tokens[n].kind != (n % 2 ? '.' : TK_NAME)) config_error(j, "invalid module path prefix");
    if (count % 2 != 0) config_error(j, "invalid module path prefix");
    return prefix;
}
char *canonical_path(Context *ctx, const char *path) {
    char resolved[PATH_MAX];
    if (!realpath(path, resolved)) { ctx->status = 74; fail(ctx, 0, 0, "cannot canonicalize path '%s'", path); }
    return copy_text(ctx, resolved, strlen(resolved));
}
char *relative_path(Context *ctx, const char *directory, const char *path) {
    if (*path == '/') return copy_text(ctx, path, strlen(path));
    Token base = {.text = directory, .length = strlen(directory)}, part = {.text = path, .length = strlen(path)};
    return (char *)join_name(ctx, base, part, base.length && directory[base.length - 1] == '/' ? "" : "/").text;
}
char *source_directory(Context *ctx, const char *absolute) {
    char *directory = copy_text(ctx, absolute, strlen(absolute));
    char *slash = strrchr(directory, '/'); slash[slash == directory ? 1 : 0] = 0;
    return directory;
}
static ModuleRoot *json_root(Json *j, const char *directory) {
    ModuleRoot *root = allocate(j->ctx, sizeof(*root));
    unsigned fields = 0;
    json_expect(j, '{');
    do {
        char *key = json_string(j); json_expect(j, ':'); char *value = json_string(j);
        unsigned bit;
        if (!strcmp(key, "package")) { bit = 1; package_name(j, value); root->package = value; }
        else if (!strcmp(key, "prefix")) { bit = 2; root->prefix = module_prefix(j, value); }
        else if (!strcmp(key, "path")) {
            bit = 4;
            if (!*value) config_error(j, "empty source root");
            root->directory = canonical_path(j->ctx, relative_path(j->ctx, directory, value));
        } else config_error(j, "unknown source-root key");
        if (fields & bit) config_error(j, "duplicate source-root key");
        fields |= bit;
        if (json_take(j, '}')) break;
        json_expect(j, ',');
    } while (true);
    if (fields != 7) config_error(j, "source root requires package, prefix and path");
    return root;
}
static PackageDependency *json_dependency(Json *j) {
    PackageDependency *edge = allocate(j->ctx, sizeof(*edge));
    unsigned fields = 0;
    json_expect(j, '{');
    do {
        char *key = json_string(j); json_expect(j, ':'); char *value = json_string(j);
        package_name(j, value);
        unsigned bit;
        if (!strcmp(key, "from")) { bit = 1; edge->from = value; }
        else if (!strcmp(key, "to")) { bit = 2; edge->to = value; }
        else config_error(j, "unknown dependency key");
        if (fields & bit) config_error(j, "duplicate dependency key");
        fields |= bit;
        if (json_take(j, '}')) break;
        json_expect(j, ',');
    } while (true);
    if (fields != 3) config_error(j, "dependency requires from and to");
    return edge;
}
static bool registered(const ModuleConfig *config, const char *package) {
    for (ModuleRoot *root = config->roots; root; root = root->next)
        if (!strcmp(root->package, package)) return true;
    return false;
}
ModuleConfig *read_manifest(Context *ctx, const char *path) {
    const char *saved = ctx->filename;
    ctx->filename = path;
    char *absolute = source_directory(ctx, canonical_path(ctx, path));
    size_t size; unsigned char *text = read_file(ctx, path, &size);
    Json j = {ctx, text, 0, size};
    ModuleConfig *config = allocate(ctx, sizeof(*config));
    ModuleRoot **roots = &config->roots; PackageDependency **edges = &config->dependencies;
    unsigned fields = 0, root_count = 0, edge_count = 0;
    json_expect(&j, '{');
    do {
        char *key = json_string(&j); json_expect(&j, ':');
        unsigned bit;
        if (!strcmp(key, "version")) { bit = 1; json_expect(&j, '1'); }
        else if (!strcmp(key, "package")) { bit = 2; config->package = json_string(&j); package_name(&j, config->package); }
        else if (!strcmp(key, "module_roots")) {
            bit = 4; json_expect(&j, '[');
            if (!json_take(&j, ']')) {
                do {
                    if (++root_count > L_MAX_MODULES) config_error(&j, "too many source roots");
                    *roots = json_root(&j, absolute); roots = &(*roots)->next;
                    if (json_take(&j, ']')) break;
                    json_expect(&j, ',');
                } while (true);
            }
        } else if (!strcmp(key, "dependencies")) {
            bit = 8; json_expect(&j, '[');
            if (!json_take(&j, ']')) {
                do {
                    if (++edge_count > L_MAX_IMPORTS) config_error(&j, "too many package dependencies");
                    *edges = json_dependency(&j); edges = &(*edges)->next;
                    if (json_take(&j, ']')) break;
                    json_expect(&j, ',');
                } while (true);
            }
        } else config_error(&j, "unknown manifest key");
        if (fields & bit) config_error(&j, "duplicate manifest key");
        fields |= bit;
        if (json_take(&j, '}')) break;
        json_expect(&j, ',');
    } while (true);
    if (fields != 15) config_error(&j, "manifest requires version, package, module_roots and dependencies");
    json_space(&j);
    if (j.at != j.size) config_error(&j, "trailing data");
    if (!registered(config, config->package)) config_error(&j, "entry package has no source root");
    for (PackageDependency *edge = config->dependencies; edge; edge = edge->next)
        if (!registered(config, edge->from) || !registered(config, edge->to)) config_error(&j, "dependency package has no source root");
    ctx->filename = saved;
    return config;
}
