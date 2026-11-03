#include "../bootstrap/stage0/l.h"

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#define FUZZ_SEED UINT32_C(0x4c313146)
#define MAX_INPUT 65536u
#define MODEL_CASES 128u

typedef struct { const unsigned char *bytes; size_t size; } Seed;
static uint32_t random_state = FUZZ_SEED;
static size_t inputs, accepted, rejected, programs, executions;
static char source[MAX_INPUT];
static size_t source_length;

static _Noreturn void failed(const char *message) {
    fprintf(stderr, "FAIL: %s\n", message);
    puts("fuzz: FAILED; see build/fuzz.log (fixed seed 0x4c313146)");
    exit(1);
}
static uint32_t random_number(uint32_t bound) {
    random_state ^= random_state << 13;
    random_state ^= random_state >> 17;
    random_state ^= random_state << 5;
    return random_state % bound;
}
static Context *context(const char *filename) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) failed("test harness allocation failed");
    ctx->filename = filename;
    return ctx;
}
static void dispose(Context *ctx) { cleanup(ctx); free(ctx); }
static Program *compile(Context *ctx, const char *text) {
    size_t count;
    Token *tokens = lex(ctx, text, strlen(text), &count);
    Ast *ast = parse(ctx, tokens, count);
    analyze(ctx, ast);
    Program *p = lower(ctx, ast);
    verify(ctx, p);
    return p;
}
static Program *roundtrip(Context *ctx, const Program *p) {
    write_bytecode(ctx, p, "build/fuzz-roundtrip.lbc");
    size_t size;
    const unsigned char *bytes = read_file(ctx, "build/fuzz-roundtrip.lbc", &size);
    return read_bytecode(ctx, bytes, size);
}
static void run_expected(const Program *p, int32_t expected, int status) {
    Context *ctx = context("fuzz-execution");
    ++executions;
    if (!setjmp(ctx->failure)) {
        int32_t result = execute_program(ctx, p);
        if (result != expected) failed("VM result differs from the independent model");
    }
    if (ctx->status != status) failed("unexpected VM trap status");
    dispose(ctx);
}
static void semantic_case(int32_t expected, int status) {
    ++programs;
    fprintf(stderr, "semantic case %zu: expected value=%d status=%d\n%s\n", programs, expected, status, source);
    Context *ctx = context("fuzz-source");
    if (setjmp(ctx->failure)) failed("generated source or its bytecode was rejected");
    Program *p = compile(ctx, source);
    Program *loaded = roundtrip(ctx, p);
    run_expected(p, expected, status);
    run_expected(loaded, expected, status);
    dispose(ctx);
}
static void append(const char *format, ...) {
    va_list args;
    va_start(args, format);
    int count = vsnprintf(source + source_length, sizeof(source) - source_length, format, args);
    va_end(args);
    if (count < 0 || (size_t)count >= sizeof(source) - source_length) failed("generated source exceeds its buffer");
    source_length += (size_t)count;
}

/* Deserialization and verification only: arbitrary mutants may contain infinite loops. */
static void fuzz_input(const unsigned char *bytes, size_t size) {
    ++inputs;
    fprintf(stderr, "bytecode input %zu: length=%zu\n", inputs, size);
    Context *ctx = context("fuzz-bytecode");
    if (!setjmp(ctx->failure)) (void)read_bytecode(ctx, bytes, size);
    if (!ctx->status) ++accepted;
    else if (ctx->status == 65) ++rejected;
    else failed("bytecode parser returned an unexpected status");
    dispose(ctx);
}
static void fuzz_bytecode(void) {
    static const char *const sources[] = {
        "int main(){return 42;}",
        "int main(){int a[5];bool skip[5];skip[1]=true;int sum=0;"
            "for(int i=0;i<5;i++){a[i]=i*i;if(skip[i])continue;if(i==4)break;sum=sum+a[i];}return sum+29;}",
        "int choose(bool active,int value){if(active)return value;return 0;}"
            "void nop(){}int main(){nop();int a[2];a[1]=42;return choose(true,a[1]);}",
        "int fact(int n){if(n<2)return 1;return n*fact(n-1);}int main(){return fact(3)+36;}",
        "bool valid(int n){return n>0&&n<10;}int main(){int n=0;int sum=0;"
            "while(valid(n=n+1)){int a[1];a[0]=n;if(n%2==0)continue;sum=sum+a[0];if(n==5)break;}return sum+33;}"
    };
    Seed seeds[sizeof(sources) / sizeof(*sources)];
    Context *ctx = context("fuzz-seed");
    if (setjmp(ctx->failure)) failed("could not build the bytecode corpus");
    for (size_t i = 0; i < sizeof(seeds) / sizeof(*seeds); ++i) {
        Program *p = compile(ctx, sources[i]);
        run_expected(p, 42, 0);
        write_bytecode(ctx, p, "build/fuzz-roundtrip.lbc");
        seeds[i].bytes = read_file(ctx, "build/fuzz-roundtrip.lbc", &seeds[i].size);
        if (seeds[i].size * 2 + 32 > MAX_INPUT) failed("seed exceeds the mutation buffer");
    }
    unsigned char *bytes = malloc(MAX_INPUT);
    if (!bytes) failed("could not allocate the mutation buffer");
    static const uint32_t words[] = {0, 1, 2, UINT32_MAX, UINT32_C(0x80000000), L_MAX_CODE + 1, L_MAX_REGISTERS + 1};
    for (size_t s = 0; s < sizeof(seeds) / sizeof(*seeds); ++s) {
        const Seed *seed = &seeds[s];
        fuzz_input(seed->bytes, seed->size);
        for (size_t cut = 0; cut < seed->size; ++cut) fuzz_input(seed->bytes, cut);
        for (size_t at = 0; at < seed->size; ++at) {
            memcpy(bytes, seed->bytes, seed->size);
            bytes[at] ^= 255;
            fuzz_input(bytes, seed->size);
        }
        for (unsigned iteration = 0; iteration < 256; ++iteration) {
            size_t size = seed->size, at = random_number((uint32_t)size);
            memcpy(bytes, seed->bytes, size);
            switch (iteration % 9) {
            case 0: bytes[at] ^= (unsigned char)(1u << random_number(8)); break;
            case 1: bytes[at] = (unsigned char)random_number(256); break;
            case 2: {
                at = random_number((uint32_t)size - 3);
                uint32_t value = words[random_number(sizeof(words) / sizeof(*words))];
                for (unsigned j = 0; j < 4; ++j) bytes[at + j] = (unsigned char)(value >> (8 * j));
                break;
            }
            case 3:
                memmove(bytes + at + 1, bytes + at, size - at);
                bytes[at] = (unsigned char)random_number(256); ++size; break;
            case 4: {
                size_t available = size - at;
                size_t removed = 1 + random_number((uint32_t)(available > 16 ? 16 : available));
                memmove(bytes + at, bytes + at + removed, size - at - removed); size -= removed; break;
            }
            case 5: {
                unsigned extra = 1 + random_number(16);
                for (unsigned j = 0; j < extra; ++j) bytes[size++] = (unsigned char)random_number(256);
                break;
            }
            case 6: {
                const Seed *other = &seeds[random_number(sizeof(seeds) / sizeof(*seeds))];
                size_t cut = random_number((uint32_t)other->size);
                memcpy(bytes + at, other->bytes + cut, other->size - cut); size = at + other->size - cut; break;
            }
            case 7: size = at; break;
            case 8:
                for (unsigned j = 0; j < 8; ++j) {
                    size_t position = random_number((uint32_t)size);
                    unsigned char mask = (unsigned char)random_number(256);
                    bytes[position] ^= mask;
                }
                break;
            }
            fuzz_input(bytes, size);
        }
    }
    for (unsigned i = 0; i < 64; ++i) {
        size_t size = random_number(257);
        for (size_t j = 0; j < size; ++j) bytes[j] = (unsigned char)random_number(256);
        fuzz_input(bytes, size);
    }
    free(bytes); dispose(ctx);
    if (accepted <= sizeof(seeds) / sizeof(*seeds) || !rejected) failed("mutation corpus did not exercise both outcomes");
}

/* A host-side array/flag model supplies exact, full-width results, not just exit codes. */
static void model_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        unsigned length = 1 + random_number(16), operations = 8 + random_number(33);
        int32_t data[16] = {0}; bool flags[16] = {false}; int64_t expected = 0;
        source_length = 0;
        append("int main(){int data[%u];bool flags[%u];int sum=0;int cursor=0;", length, length);
        for (unsigned op = 0; op < operations; ++op) {
            unsigned at = random_number(length), other = random_number(length);
            int32_t value = (int32_t)random_number(201) - 100;
            switch (random_number(8)) {
            case 0: append("data[%u]=%d;", at, value); data[at] = value; break;
            case 1: append("sum=sum+data[%u]++;", at); expected += data[at]++; break;
            case 2: append("sum=sum+data[%u]--;", at); expected += data[at]--; break;
            case 3:
                append("cursor=%u;sum=sum+data[cursor++]++;sum=sum+cursor;", at);
                expected += data[at]++; expected += at + 1; break;
            case 4: append("flags[%u]=!flags[%u];", at, at); flags[at] = !flags[at]; break;
            case 5:
                append("data[%u]=data[%u]+%d;", at, other, value);
                data[at] = data[other] + value; break;
            case 6:
                append("if(flags[%u])data[%u]=%d;else data[%u]=%d;", at, at, value, at, -value);
                data[at] = flags[at] ? value : -value; break;
            case 7:
                append("sum=sum+data[%u];if(flags[%u])sum++;else sum--;", at, at);
                expected += data[at]; expected += flags[at] ? 1 : -1; break;
            }
        }
        unsigned stop = random_number(length + 1);
        append("for(int i=0;i<%u;i++){if(i==%u)break;if(flags[i])continue;sum=sum+data[i]*(i+1);}", length, stop);
        for (unsigned i = 0; i < stop; ++i) if (!flags[i]) expected += (int64_t)data[i] * (i + 1);
        append("for(int i=0;i<%u;i++){sum=sum+data[i]*(i+1);if(flags[i])sum=sum+17;}return sum;}", length);
        for (unsigned i = 0; i < length; ++i) {
            expected += (int64_t)data[i] * (i + 1);
            if (flags[i]) expected += 17;
        }
        if (expected < INT32_MIN || expected > INT32_MAX) failed("model result exceeds int range");
        semantic_case((int32_t)expected, 0);
    }
}
static void bounds_cases(void) {
    for (unsigned length = 1; length <= 16; ++length) {
        int32_t indexes[] = {INT32_MIN, -(int32_t)length, -1, 0, (int32_t)length - 1,
                            (int32_t)length, (int32_t)length + 1, INT32_MAX};
        for (size_t j = 0; j < sizeof(indexes) / sizeof(*indexes); ++j) {
            int32_t index = indexes[j];
            int status = index < 0 || (uint32_t)index >= length ? 70 : 0;
            for (unsigned operation = 0; operation < 6; ++operation) {
                source_length = 0;
                if (operation < 4) {
                    append("int main(){int a[%u];", length);
                    if (!operation) append("return a[%d];}", index);
                    else if (operation == 1) append("a[%d]=42;return a[%d];}", index, index);
                    else append("return a[%d]%s;}", index, operation == 2 ? "++" : "--");
                } else {
                    append("int main(){bool a[%u];", length);
                    if (operation == 5) append("a[%d]=true;", index);
                    append("if(a[%d])return 1;return 0;}", index);
                }
                int32_t expected = operation == 1 ? 42 : operation == 5 ? 1 : 0;
                semantic_case(expected, status);
            }
        }
    }
}

int main(void) {
    if (!freopen("build/fuzz.log", "w", stderr)) { puts("fuzz: cannot open build/fuzz.log"); return 1; }
    setvbuf(stderr, NULL, _IONBF, 0);
    fprintf(stderr, "Deterministic fuzz seed: 0x%08x\n", FUZZ_SEED);
    fuzz_bytecode();
    random_state = FUZZ_SEED;
    model_cases();
    bounds_cases();
    remove("build/fuzz-roundtrip.lbc");
    printf("fuzz: %zu bytecode inputs (%zu accepted, %zu rejected); %zu semantic programs, %zu VM executions passed\n",
           inputs, accepted, rejected, programs, executions);
    return 0;
}
