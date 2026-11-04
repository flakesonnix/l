#ifndef L_TEST_SOURCE_H
#define L_TEST_SOURCE_H

/* Legacy semantic bodies are embedded in an explicit virtual test module. */
static const char *test_source(Context *ctx, const char *source) {
    if (!strncmp(source, "module ", 7)) return source;
    size_t size = strlen(source);
    char *text = allocate(ctx, size + 14);
    memcpy(text, "module test;\n", 13); memcpy(text + 13, source, size + 1);
    return text;
}

#endif
