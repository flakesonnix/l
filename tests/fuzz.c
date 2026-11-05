#include "../bootstrap/stage0/l.h"

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include "source.h"

#define FUZZ_SEED UINT32_C(0x4c313146)
#define MAX_INPUT 65536u
#define MODEL_CASES 128u

typedef struct { const unsigned char *bytes; size_t size; } Seed;
static uint32_t random_state = FUZZ_SEED;
static size_t inputs, accepted, rejected, programs, executions;
static size_t graphs, valid_graphs, invalid_graphs;
static size_t lifecycle_programs;
static size_t shape_programs;
static size_t struct_programs;
static size_t enum_programs;
static size_t byte_programs;
static size_t string_programs;
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
    text = test_source(ctx, text);
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
    fprintf(stderr, "semantic case %zu: expected value=%d status=%d\nmodule test;\n%s\n", programs, expected, status, source);
    Context *ctx = context("fuzz-source");
    if (setjmp(ctx->failure)) failed("generated source or its bytecode was rejected");
    Program *p = compile(ctx, source);
    Program *loaded = roundtrip(ctx, p);
    run_expected(p, expected, status);
    run_expected(loaded, expected, status);
    if (p->global_count) {
        run_expected(p, expected, status);
        run_expected(loaded, expected, status);
    }
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
            "while(valid(n=n+1)){int a[1];a[0]=n;if(n%2==0)continue;sum=sum+a[0];if(n==5)break;}return sum+33;}",
        "int pick(int n){switch(n){case 0:return 10;case 1:case 2:return 30;default:return 99;}}"
            "int main(){return pick(0)+pick(1)+pick(2)+pick(9)-127;}",
        "const int minimum=-2147483648;namespace values{pub const int half=21;const bool ready=half*2==42&&minimum<0;}"
            "int main(){if(values::ready)return values::half*2;return 0;}",
        "const int start=40;static int counter=start;static bool active=true;int next(){return counter++;}"
            "int main(){if(active){active=false;return next()+next()-39;}return 0;}",
        "struct Pair{int x;bool ready;};Pair bump(Pair p){p.x++;return p;}"
            "int main(){Pair p=Pair{41,true};Pair q=bump(p);if(p.x!=41||!q.ready)return 1;return q.x;}",
        "enum K{A=-7,B=2147483647,C=-2147483648,Alias=-7};const K first=K::A;static K state=first;"
            "struct P{K kind;};K swap(K k){K old=state;state=k;return old;}"
            "int main(){P p=P{swap(K::C)};if(state!=K::C)return 1;switch(p.kind){case K::Alias:return 42;default:return 0;}}",
        "using Octet=byte;const Octet first=byte(41);static byte state=first;struct P{byte b;};"
            "byte next(){byte old=state;state=byte(int(state)+1);return old;}"
            "int main(){byte a[2];P p=P{next()};a[1]=state;if(int(p.b)!=41||int(a[0])!=0)return 1;"
            "switch(a[1]){case byte(42):return int(a[1]);default:return 0;}}",
        "using Text=string;const Text initial=\"a\\0\\xff\";static string cell=initial;struct P{string s;};"
            "string swap(string s){string old=cell;cell=s;return old;}"
            "int main(){P p=P{swap(\"*\")};if(p.s.length!=3||int(p.s[1])!=0||int(p.s[2])!=255||cell!=\"*\")return 1;"
            "if(\"\"!=\"\"||p.s!=initial)return 1;return int(cell[0]);}"
    };
    Seed seeds[sizeof(sources) / sizeof(*sources)];
    Context *ctx = context("fuzz-seed");
    if (setjmp(ctx->failure)) failed("could not build the bytecode corpus");
    for (size_t i = 0; i < sizeof(seeds) / sizeof(*seeds); ++i) {
        Program *p = compile(ctx, sources[i]);
        run_expected(p, 42, 0);
        if (p->global_count) run_expected(p, 42, 0);
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

typedef struct { int32_t value, delta; unsigned action; } ModelLabel;
static unsigned switch_table(ModelLabel labels[8], unsigned *fallback, unsigned actions) {
    int32_t values[] = {INT32_MIN, INT32_MAX, -97, -1, 0, 1, 2, 97};
    unsigned count = random_number(9);
    *fallback = random_number(count + 1); /* count means no default. */
    for (unsigned j = 8; j > 1; --j) {
        unsigned at = random_number(j);
        int32_t saved = values[j - 1]; values[j - 1] = values[at]; values[at] = saved;
    }
    for (unsigned j = 0; j < count; ++j)
        labels[j] = (ModelLabel){values[j], (int32_t)random_number(201) - 100, random_number(actions)};
    return count;
}
static unsigned switch_target(const ModelLabel *labels, unsigned count, unsigned fallback, int32_t key) {
    for (unsigned j = 0; j < count; ++j) if (j != fallback && labels[j].value == key) return j;
    return fallback;
}
/* Interpret label bodies independently, testing every label plus two unmatched keys. */
static void switch_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        ModelLabel labels[8]; unsigned fallback;
        unsigned count = switch_table(labels, &fallback, 4);
        int32_t initial = (int32_t)random_number(201) - 100;
        int32_t after = (int32_t)random_number(201) - 100, expected = 0;
        source_length = 0;
        append("int pick(int key){int sum=%d;int cursor=0;int keys[1];keys[0]=key;switch(keys[cursor++]){", initial);
        for (unsigned j = 0; j < count; ++j) {
            if (j == fallback) append("default:");
            else append("case %d:", labels[j].value);
            unsigned action = labels[j].action;
            if (!action) continue; /* Empty labels fall into the next body. */
            append("sum=sum+%d;", labels[j].delta);
            if (action == 2) append("break;1/0;");
            if (action == 3) append("return sum+cursor*37;1/0;");
        }
        append("}return sum+%d+cursor*37;}int main(){int total=0;", after);
        for (unsigned sample = 0; sample < count + 2; ++sample) {
            int32_t key = sample < count ? labels[sample].value : sample == count ? -1001 : 1001;
            int32_t result = initial; bool returned = false;
            for (unsigned at = switch_target(labels, count, fallback, key); at < count; ++at) {
                unsigned action = labels[at].action;
                if (!action) continue;
                result += labels[at].delta;
                if (action == 3) returned = true;
                if (action >= 2) break;
            }
            expected += result + 37 + (returned ? 0 : after);
            append("total=total+pick(%d);", key);
        }
        append("return total;}");
        semantic_case(expected, 0);
    }
}
/* Nested breaks stay in their switch; continues skip switches and reach the loop. */
static void switch_loop_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        ModelLabel labels[8]; unsigned fallback;
        unsigned count = switch_table(labels, &fallback, 5), length = count + 2;
        int32_t initial = (int32_t)random_number(201) - 100, expected = initial;
        source_length = 0;
        append("int main(){int sum=%d;int cursor=0;int keys[%u];", initial, length);
        for (unsigned sample = 0; sample < length; ++sample) {
            int32_t key = sample < count ? labels[sample].value : sample == count ? -1001 : 1001;
            append("keys[%u]=%d;", sample, key);
            bool continued = false;
            for (unsigned at = switch_target(labels, count, fallback, key); at < count; ++at) {
                expected += labels[at].delta;
                unsigned action = labels[at].action;
                if (action == 1) break;
                if (action == 2) { continued = true; break; }
                if (action == 3) expected += (key == labels[at].value ? 17 : -11) + 5;
                if (action == 4) {
                    continued = key == labels[at].value;
                    if (!continued) expected += 10;
                    break;
                }
            }
            if (!continued) expected += 101;
        }
        if (test % 2) append("int i=0;while(i<%u){i++;", length);
        else append("for(int i=0;i<%u;i++){", length);
        append("switch(keys[cursor++]){");
        for (unsigned j = 0; j < count; ++j) {
            if (j == fallback) append("default:");
            else append("case %d:", labels[j].value);
            append("sum=sum+%d;", labels[j].delta);
            switch (labels[j].action) {
            case 0: break; /* Fall through. */
            case 1: append("break;"); break;
            case 2: append("continue;1/0;"); break;
            case 3:
                append("switch(keys[cursor-1]){case %d:sum=sum+17;break;default:sum=sum-11;}sum=sum+5;", labels[j].value);
                break;
            case 4:
                append("switch(keys[cursor-1]){case %d:continue;default:sum=sum+7;break;}sum=sum+3;break;", labels[j].value);
                break;
            }
        }
        append("}sum=sum+101;}return sum+cursor*37;}");
        semantic_case(expected + (int32_t)length * 37, 0);
    }
}
static void switch_limit_cases(void) {
    for (unsigned has_default = 0; has_default < 2; ++has_default) {
        unsigned count = L_MAX_CASES - has_default;
        source_length = 0;
        append("int pick(int key){switch(key){");
        for (unsigned j = 0; j < count; ++j) append("case %u:", j);
        append("return 42;");
        if (has_default) append("default:return 7;");
        append("}return 0;}int main(){return pick(0)+pick(%u)+pick(%u);}", count - 1, count);
        semantic_case(84 + (has_default ? 7 : 0), 0);
    }
}

/* Independent lengths, indexes and dispatch outcomes for folded storage/label expressions. */
static void shape_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        uint32_t length = 1 + random_number(16);
        int32_t anchor = (int32_t)random_number(2001) - 1000;
        int32_t factor = (int32_t)random_number(201) - 100;
        int32_t delta = (int32_t)random_number(4) - 1;
        uint32_t index = delta == -1 ? 0 : delta == 0 ? length - 1 : length / 2;
        source_length = 0;
        append("using Index=int;const Index span=limits::width;"
               "namespace limits{const Index width=%u;const Index anchor=%d;}"
               "const Index choice=limits::anchor+(%d);"
               "Index pick(Index key){Index data[(span*3+2)/3];"
               "for(Index i=0;i<span;i++)data[i]=(i+1)*(%d);"
               "switch(key){case limits::anchor-1:return data[0];"
               "case limits::anchor+0:return data[span-1];"
               "case limits::anchor+1:return data[span/2];"
               "default:return data[span];}}int main(){return pick(choice);}", length, anchor, delta, factor);
        ++shape_programs;
        semantic_case((int32_t)(index + 1) * factor, delta == 2 ? 70 : 0);
    }
}

typedef struct { int32_t variable; int status; } ExpressionModel;
static int32_t expression_checked(ExpressionModel *model, int64_t value) {
    if (model->status) return 0;
    if (value < INT32_MIN || value > INT32_MAX) { model->status = 70; return 0; }
    return (int32_t)value;
}
static int32_t expression_value(void) {
    static const int32_t edges[] = {INT32_MIN, INT32_MIN + 1, INT32_MAX - 1, INT32_MAX, -97, -1, 0, 1, 97};
    return random_number(2) ? edges[random_number(sizeof(edges) / sizeof(*edges))] : (int32_t)random_number(201) - 100;
}
/* Emit typed expressions while a host-side model tracks values, effects and traps. */
static int32_t expression_model(ExpressionModel *model, unsigned depth, bool boolean) {
    if (boolean) {
        unsigned kind = random_number(depth ? 5 : 2);
        if (!kind) {
            int32_t value = (int32_t)random_number(2);
            append(value ? "true" : "false"); return value;
        }
        if (kind == 1) {
            static const char *const operators[] = {"==", "!=", "<", "<=", ">", ">="};
            unsigned op = random_number(6);
            append("("); int32_t a = expression_model(model, depth ? depth - 1 : 0, false);
            append("%s", operators[op]); int32_t b = expression_model(model, depth ? depth - 1 : 0, false);
            append(")");
            switch (op) {
            case 0: return a == b; case 1: return a != b; case 2: return a < b;
            case 3: return a <= b; case 4: return a > b; default: return a >= b;
            }
        }
        if (kind == 2) {
            append("(!"); int32_t value = expression_model(model, depth - 1, true); append(")"); return !value;
        }
        append("("); int32_t a = expression_model(model, depth - 1, true);
        bool conjunction = kind == 3;
        append(conjunction ? "&&" : "||");
        ExpressionModel skipped = *model;
        bool shorted = conjunction ? !a : a != 0;
        int32_t b = expression_model(shorted ? &skipped : model, depth - 1, true);
        append(")"); return conjunction ? a && b : a || b;
    }
    unsigned kind = random_number(depth ? 9 : 6);
    if (kind < 6) {
        int32_t value = expression_value();
        if (!kind || kind == 5) { append("(%d)", value); return value; }
        if (kind == 1) { append("n"); return model->variable; }
        if (kind == 4) {
            append("(n=%d)", value);
            if (!model->status) model->variable = value;
            return value;
        }
        bool increment = kind == 2;
        append(increment ? "n++" : "n--");
        int32_t old = model->variable;
        int32_t next = expression_checked(model, (int64_t)old + (increment ? 1 : -1));
        if (!model->status) model->variable = next;
        return old;
    }
    if (kind == 6) {
        bool negative = random_number(2) != 0;
        append(negative ? "(-" : "(+");
        int32_t value = expression_model(model, depth - 1, false);
        append(")"); return expression_checked(model, negative ? -(int64_t)value : value);
    }
    unsigned op = random_number(5);
    append(kind == 8 ? "pair(" : "(");
    int32_t a = expression_model(model, depth - 1, false);
    static const char operators[] = "+-*/%";
    if (kind == 8) append(","); else append("%c", operators[op]);
    int32_t b = expression_model(model, depth - 1, false);
    append(")");
    if (model->status) return 0;
    if (kind == 8) {
        int32_t product = expression_checked(model, (int64_t)a * 3);
        return expression_checked(model, (int64_t)product + b);
    }
    if (op >= 3 && (!b || (a == INT32_MIN && b == -1))) { model->status = 70; return 0; }
    switch (op) {
    case 0: return expression_checked(model, (int64_t)a + b);
    case 1: return expression_checked(model, (int64_t)a - b);
    case 2: return expression_checked(model, (int64_t)a * b);
    case 3: return expression_checked(model, (int64_t)a / b);
    default: return expression_checked(model, (int64_t)a % b);
    }
}
static void expression_cases(void) {
    unsigned successes = 0, traps = 0;
    for (unsigned test = 0; test < MODEL_CASES * 4; ++test) {
        ExpressionModel model = {expression_value(), 0};
        bool boolean = test % 2 != 0;
        source_length = 0;
        append("int pair(int a,int b){return a*3+b;}int main(){int n=%d;%s value=", model.variable, boolean ? "bool" : "int");
        int32_t expected = expression_model(&model, 1 + random_number(5), boolean);
        append(";if(n!=%d)1/0;", model.variable);
        append(boolean ? "if(value)return 1;return 0;}" : "return value;}");
        if (model.status) ++traps; else ++successes;
        semantic_case(model.status ? 0 : expected, model.status);
    }
    if (!successes || !traps) failed("expression model did not exercise values and traps");
}
/* Independent shared-state model, with repeated runs of each source/bytecode program. */
static void static_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        int32_t counter = (int32_t)random_number(201) - 100;
        bool flag = random_number(2) != 0;
        int64_t expected = 0;
        source_length = 0;
        append("const int bias=17;static int count=%d+bias-bias;static bool flag=%s;"
               "int bump(int delta){count=count+delta;flag=!flag;return count;}"
               "int pair(int a,int b){return a*3+b;}int main(){int sum=0;", counter, flag ? "true" : "false");
        unsigned operations = 8 + random_number(33);
        for (unsigned n = 0; n < operations; ++n) {
            int32_t value = (int32_t)random_number(201) - 100;
            switch (random_number(8)) {
            case 0:
                append("sum=sum+bump(%d);", value); counter += value; flag = !flag; expected += counter; break;
            case 1: append("sum=sum+count++;"); expected += counter++; break;
            case 2: append("sum=sum+count--;"); expected += counter--; break;
            case 3: append("count=%d;flag=!flag;", value); counter = value; flag = !flag; break;
            case 4:
                append("if(flag)sum=sum+bump(%d);else count=count+2;", value);
                if (flag) { counter += value; flag = false; expected += counter; } else counter += 2;
                break;
            case 5:
                append("sum=sum+bump(bump(%d)-count);", value); counter += value; expected += counter; break;
            case 6:
                append("sum=sum+pair(bump(%d),bump(%d));", value, -value);
                expected += (int64_t)(counter + value) * 3 + counter; break;
            case 7:
                append("bool b%u=flag&&((count=count+%d)>=0);if(b%u)sum++;", n, value, n);
                if (flag) { counter += value; if (counter >= 0) ++expected; }
                break;
            }
        }
        append("if(flag)sum=sum+bias;return sum+count;}");
        expected += counter + (flag ? 17 : 0);
        if (expected < INT32_MIN || expected > INT32_MAX) failed("static model result exceeds int range");
        semantic_case((int32_t)expected, 0);
    }
}

/* Programs live in a separate arena: a caller can clean up a trapped execution and retry. */
static void reuse_execution(Context *ctx, const Program *p, int status) {
    ctx->filename = "static-lifecycle"; ctx->status = 0;
    ++executions;
    if (!setjmp(ctx->failure)) {
        if (execute_program(ctx, p) != 42) failed("static cells were not reset before execution");
    }
    if (ctx->status != status) failed("static lifecycle execution returned an unexpected status");
    if (!status && (ctx->allocated || ctx->allocations)) failed("successful static execution leaked memory");
    cleanup(ctx);
    if (ctx->allocated || ctx->allocations) failed("trapped static execution could not be cleaned up");
}
static void static_lifecycle_case(size_t test, const char *trap) {
    source_length = 0;
    append("enum Phase{Start=-7,Done=2147483647};struct Pair{int x;bool ready;Phase phase;byte octet;string text;};"
           "Pair step(Pair p){p.x++;p.phase=Phase::Done;p.octet=byte(0);p.text=\"\";return p;}"
           "static int count=41;static bool ready=true;static Phase phase=Phase::Start;static byte octet=byte(255);static string text=\"start\\0\\xff\";"
           "int descend(int n){count++;if(n>0)return descend(n-1);return count;}"
           "int fail(){Pair p=step(Pair{count,ready,phase,octet,text});count=p.x;phase=p.phase;octet=p.octet;text=p.text;ready=false;%s}"
           "int main(){if(count!=41||!ready||phase!=Phase::Start||octet!=byte(255)||text!=\"start\\0\\xff\")return 1;return fail();}"
           "int recover(){if(count!=41||!ready||phase!=Phase::Start||octet!=byte(255)||text!=\"start\\0\\xff\")return 1;Pair p=step(Pair{count,ready,phase,octet,text});"
           "count=99;phase=p.phase;octet=p.octet;text=p.text;ready=false;return p.x;}", trap);
    ++programs; ++lifecycle_programs;
    fprintf(stderr, "static lifecycle case %zu:\nmodule test;\n%s\n", test, source);
    Context *owner = context("static-lifecycle-source");
    if (setjmp(owner->failure)) failed("static lifecycle program was rejected");
    Program *compiled = compile(owner, source), *loaded = roundtrip(owner, compiled);
    const Program *versions[] = {compiled, loaded};
    for (unsigned version = 0; version < 2; ++version) {
        const Program *p = versions[version];
        Program recovery = *p;
        recovery.entry = L_NONE;
        for (uint32_t j = 0; j < p->function_count; ++j)
            if (!strcmp(p->functions[j].name, "test::recover")) recovery.entry = j;
        verify(owner, &recovery);
        if (p->global_count != 5) failed("static lifecycle program has the wrong cell count");
        IrGlobal initial[5]; memcpy(initial, p->globals, sizeof(initial));
        write_bytecode(owner, p, "build/fuzz-roundtrip.lbc");
        size_t before_size;
        const unsigned char *before = read_file(owner, "build/fuzz-roundtrip.lbc", &before_size);
        Context *execution = context("static-lifecycle");
        for (unsigned attempt = 0; attempt < 4; ++attempt) {
            reuse_execution(execution, p, 70);
            if (memcmp(initial, p->globals, sizeof(initial))) failed("trap mutated the initializer table");
            reuse_execution(execution, &recovery, 0);
            reuse_execution(execution, &recovery, 0);
            if (memcmp(initial, p->globals, sizeof(initial))) failed("return mutated the initializer table");
        }
        dispose(execution);
        write_bytecode(owner, p, "build/fuzz-roundtrip.lbc");
        size_t after_size;
        const unsigned char *after = read_file(owner, "build/fuzz-roundtrip.lbc", &after_size);
        if (after_size != before_size || memcmp(before, after, before_size)) failed("execution changed serialized bytecode");
    }
    dispose(owner);
}
static void static_lifecycle_cases(void) {
    static const char *const traps[] = {
        "return count+2147483647;",
        "count=-2147483648;return -count;",
        "count=0;return 1/count;",
        "count=0;return 1%count;",
        "count=-2147483648;return count/-1;",
        "count=-2147483648;return count%-1;",
        "int data[1];return data[count];",
        "int data[1];data[count]=1;return 0;",
        "return descend(256);",
        "for(int n=0;n<2000000;n++){count++;}return count;",
        "switch(phase){case Phase::Start:return 0;default:return 1/(count-42);}",
        "return int(byte(count+214));",
        "return int(byte(int(octet)-1));",
        "byte data[1];data[0]=octet;return int(data[count]);",
        "return int(text[0]);",
        "text=\"x\";return int(text[count]);",
        "text=\"x\";return int(text[-count]);"
    };
    for (size_t test = 0; test < sizeof(traps) / sizeof(*traps); ++test) static_lifecycle_case(test, traps[test]);
}

typedef struct { int32_t x, y; bool active; } StructModel;
static StructModel struct_change(StructModel p, int32_t delta) {
    p.x += delta; p.y -= delta; p.active = !p.active; return p;
}
static int32_t struct_score(StructModel p) { return p.active ? p.x * 3 + p.y : p.x - p.y * 2; }
static void struct_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        StructModel p = {(int32_t)random_number(201) - 100, (int32_t)random_number(201) - 100, random_number(2) != 0};
        StructModel q = {(int32_t)random_number(201) - 100, (int32_t)random_number(201) - 100, random_number(2) != 0};
        int64_t expected = 0;
        source_length = 0;
        append("struct Pair{int x;bool active;int y;};"
               "Pair change(Pair p,int delta){p.x=p.x+delta;p.y=p.y-delta;p.active=!p.active;return p;}"
               "int score(Pair p){if(p.active)return p.x*3+p.y;return p.x-p.y*2;}"
               "Pair choose(Pair a,Pair b,bool first){if(first)return a;return b;}"
               "int combine(Pair a,int bias,Pair b){return score(a)+bias+score(b);}"
               "Pair walk(Pair p,int n){if(n==0)return p;return walk(change(p,1),n-1);}"
               "int main(){Pair p=Pair{%d,%s,%d};Pair q=Pair{%d,%s,%d};int sum=0;",
               p.x, p.active ? "true" : "false", p.y, q.x, q.active ? "true" : "false", q.y);
        for (unsigned op = 0; op < 24; ++op) {
            int32_t delta = (int32_t)random_number(41) - 20;
            switch (random_number(10)) {
            case 0:
                append("q=change(p,%d);sum=sum+score(q);", delta); q = struct_change(p, delta); expected += struct_score(q); break;
            case 1:
                append("q=p;q.x++;p.y--;sum=sum+score(p)+score(q);"); q = p; ++q.x; --p.y;
                expected += struct_score(p) + struct_score(q); break;
            case 2:
                append("p=q;q=change(q,%d);sum=sum+p.x;", delta); p = q; q = struct_change(q, delta); expected += p.x; break;
            case 3:
                append("p=Pair{q.x++,!q.active,q.y--};sum=sum+score(p)+score(q);");
                p = (StructModel){q.x++, q.y--, !q.active}; expected += struct_score(p) + struct_score(q); break;
            case 4: {
                append("sum=sum+combine(p,p.x++,change(p,%d));", delta);
                StructModel first = p; int32_t bias = p.x++;
                expected += struct_score(first) + bias + struct_score(struct_change(p, delta)); break;
            }
            case 5:
                append("p=choose(p,q,p.active);sum=sum+p.x;"); if (!p.active) p = q; expected += p.x; break;
            case 6:
                append("{const Pair c=change(p,%d);sum=sum+score(c);}", delta); expected += struct_score(struct_change(p, delta)); break;
            case 7: {
                unsigned depth = random_number(4);
                append("p=walk(p,%u);sum=sum+score(p);", depth);
                for (unsigned j = 0; j < depth; ++j) p = struct_change(p, 1);
                expected += struct_score(p); break;
            }
            case 8:
                append("if(p.active&&((q.x=q.x+(%d))>0))sum++;", delta);
                if (p.active) { q.x += delta; if (q.x > 0) ++expected; } break;
            case 9:
                append("{Pair r=(p=q);q.x++;sum=sum+r.x+p.x+q.x;}");
                p = q; ++q.x; expected += p.x * 2 + q.x; break;
            }
        }
        append("return sum+score(p)+score(q);}"); expected += struct_score(p) + struct_score(q);
        if (expected < INT32_MIN || expected > INT32_MAX) failed("struct model result exceeds int range");
        ++struct_programs; semantic_case((int32_t)expected, 0);
    }
}

static unsigned enum_index(const int32_t values[8], int32_t value) {
    for (unsigned n = 0; n < 8; ++n) if (values[n] == value) return n;
    failed("enum model contains an undeclared value");
}
static void enum_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        int32_t base = (int32_t)random_number(41) - 20;
        int32_t values[8] = {base, base + 1, (int32_t)random_number(31) - 15, base, INT32_MAX, INT32_MIN, INT32_MIN + 1, 0};
        int32_t weights[8];
        for (unsigned n = 0; n < 8; ++n) weights[n] = (int32_t)random_number(101) - 50;
        unsigned pi = random_number(8), qi = random_number(8), initial = random_number(8);
        int32_t p = values[pi], q = values[qi], state = values[initial];
        int64_t expected = 0;
        source_length = 0;
        append("enum K{M0=base,M1,M2=%d,M3=base,M4=2147483647,M5=-2147483648,M6,M7=0};const int base=%d;"
               "const K first=K::M%u;static K state=first;struct P{K kind;};"
               "K swap(K k){K old=state;state=k;return old;}int score(K k){switch(k){", values[2], base, initial);
        for (unsigned n = 0; n < 8; ++n)
            if (enum_index(values, values[n]) == n) append("case K::M%u:return %d;", n, weights[n]);
        append("default:return -99;}}K rotate(K k){switch(k){");
        for (unsigned n = 0; n < 8; ++n)
            if (enum_index(values, values[n]) == n) append("case K::M%u:return K::M%u;", n, (n + 1) % 8);
        append("default:return K::M0;}}P change(P p){p.kind=rotate(p.kind);return p;}"
               "int main(){P p=P{K::M%u};P q=P{K::M%u};int sum=0;", pi, qi);
        for (unsigned op = 0; op < 24; ++op) {
            unsigned selected = random_number(8);
            switch (random_number(8)) {
            case 0:
                append("q=change(p);sum=sum+score(p.kind)+score(q.kind);");
                q = values[(enum_index(values, p) + 1) % 8];
                expected += weights[enum_index(values, p)] + weights[enum_index(values, q)]; break;
            case 1:
                append("p.kind=K::M%u;sum=sum+score(p.kind);", selected); p = values[selected];
                expected += weights[enum_index(values, p)]; break;
            case 2: {
                append("sum=sum+score(swap(p.kind))+score(state);");
                int32_t old = state; state = p;
                expected += weights[enum_index(values, old)] + weights[enum_index(values, state)]; break;
            }
            case 3:
                append("if(p.kind==q.kind){q.kind=rotate(q.kind);sum++;}else p=q;");
                if (p == q) { q = values[(enum_index(values, q) + 1) % 8]; ++expected; } else p = q;
                break;
            case 4:
                append("if(p.kind!=K::M%u&&swap(q.kind)==K::M%u)sum=sum+2;", selected, selected);
                if (p != values[selected]) { int32_t old = state; state = q; if (old == values[selected]) expected += 2; }
                break;
            case 5:
                append("{const K k=q.kind;p.kind=k;q=change(q);sum=sum+score(k);}");
                p = q; q = values[(enum_index(values, q) + 1) % 8]; expected += weights[enum_index(values, p)]; break;
            case 6:
                append("{P copy=p;p.kind=rotate(p.kind);sum=sum+score(copy.kind);}");
                expected += weights[enum_index(values, p)]; p = values[(enum_index(values, p) + 1) % 8]; break;
            case 7:
                append("p.kind=swap(q.kind);q.kind=K::M%u;sum=sum+score(p.kind);", selected);
                p = state; state = q; q = values[selected]; expected += weights[enum_index(values, p)]; break;
            }
        }
        append("return sum+score(state)+score(p.kind)+score(q.kind);}");
        expected += weights[enum_index(values, state)] + weights[enum_index(values, p)] + weights[enum_index(values, q)];
        ++enum_programs; semantic_case((int32_t)expected, 0);
    }
}

static void byte_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        unsigned length = 2 + random_number(7), data[8] = {0};
        unsigned p = random_number(256), q = random_number(256), cell = random_number(256);
        int32_t sum = 0;
        source_length = 0;
        append("using Octet=byte;struct P{byte b;int guard;};"
               "const Octet initial=byte(%u);static byte cell=initial;"
               "byte swap(byte b){byte old=cell;cell=b;return old;}"
               "P step(P p,int n){p.b=byte((int(p.b)+n)%%256);p.guard=0;return p;}"
               "int pair(byte a,byte b){return int(a)*3+int(b);}"
               "int score(byte b){switch(b){case byte(0):return -1;case byte(255):return 256;default:return int(b);}}"
               "int main(){Octet data[%u];P p=P{byte(%u),42};P q=P{byte(%u),42};int sum=0;", cell, length, p, q);
        for (unsigned op = 0; op < 24; ++op) {
            unsigned index = random_number(length), delta = random_number(256);
            switch (random_number(9)) {
            case 0:
                append("data[%u]=byte(%u);sum=sum+int(data[%u]);", index, delta, index);
                data[index] = delta; sum += (int32_t)delta; break;
            case 1:
                append("q=step(p,%u);sum=sum+int(p.b)+int(q.b);", delta);
                q = (p + delta) % 256; sum += (int32_t)(p + q); break;
            case 2:
                append("sum=sum+pair(swap(p.b),swap(q.b));"); sum += (int32_t)(cell * 3 + p); cell = q; break;
            case 3:
                append("p.b=byte((int(data[%u])+int(cell))%%256);data[%u]=swap(p.b);", index, index);
                p = (data[index] + cell) % 256; data[index] = cell; cell = p; break;
            case 4:
                append("if(p.b!=q.b&&swap(q.b)==byte(%u))sum++;", delta);
                if (p != q) { unsigned old = cell; cell = q; if (old == delta) ++sum; } break;
            case 5:
                append("{P copy=p;p=step(p,%u);sum=sum+int(copy.b);}", delta);
                sum += (int32_t)p; p = (p + delta) % 256; break;
            case 6:
                append("{int i=%u;data[i++]=byte(i);sum=sum+i+int(data[%u]);}", index, index);
                data[index] = index + 1; sum += (int32_t)(2 * (index + 1)); break;
            case 7:
                append("sum=sum+score(data[%u]);", index);
                sum += data[index] == 0 ? -1 : data[index] == 255 ? 256 : (int32_t)data[index]; break;
            case 8:
                append("{const byte keep=p.b;q.b=keep;p.b=byte(%u);sum=sum+int(keep);}", delta);
                q = p; sum += (int32_t)p; p = delta; break;
            }
        }
        append("for(int i=0;i<%u;i++)sum=sum+int(data[i]);return sum+int(p.b)+int(q.b)+int(cell);}", length);
        for (unsigned n = 0; n < length; ++n) sum += (int32_t)data[n];
        sum += (int32_t)(p + q + cell);
        ++byte_programs; semantic_case(sum, 0);
    }
    /* Every representable value and adjacent/outlying boundaries, via runtime calls. */
    for (int32_t n = -2; n <= 257; ++n) {
        source_length = 0;
        append("byte narrow(int n){return byte(n);}int main(){return int(narrow(%d));}", n);
        ++byte_programs; semantic_case(n >= 0 && n <= 255 ? n : 0, n >= 0 && n <= 255 ? 0 : 70);
    }
    static const int32_t extremes[] = {INT32_MIN, INT32_MAX};
    for (unsigned n = 0; n < 2; ++n) {
        source_length = 0; append("int main(){int n=%d;return int(byte(n));}", extremes[n]);
        ++byte_programs; semantic_case(0, 70);
    }
}

typedef struct { unsigned length; unsigned char bytes[16]; } StringModel;
static void string_literal(StringModel s) {
    append("\"");
    for (unsigned n = 0; n < s.length; ++n) append("\\x%02x", s.bytes[n]);
    append("\"");
}
static bool string_model_equal(StringModel a, StringModel b) {
    if (a.length != b.length) return false;
    for (unsigned n = 0; n < a.length; ++n) if (a.bytes[n] != b.bytes[n]) return false;
    return true;
}
static int32_t string_score(StringModel s) {
    int32_t score = (int32_t)s.length;
    for (unsigned n = 0; n < s.length; ++n) score += (int32_t)s.bytes[n] * (int32_t)(n + 1);
    return score;
}
static void string_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES; ++test) {
        StringModel values[8] = {{0, {0}}, {1, {0}}, {3, {255, 0, 42}}};
        for (unsigned n = 3; n < 7; ++n) {
            values[n].length = 1 + random_number(16);
            for (unsigned j = 0; j < values[n].length; ++j) values[n].bytes[j] = (unsigned char)random_number(256);
        }
        values[7] = values[test % 7];
        unsigned p = random_number(8), q = random_number(8), cell = random_number(8);
        int32_t sum = 0;
        source_length = 0;
        for (unsigned n = 0; n < 8; ++n) { append("const string c%u=", n); string_literal(values[n]); append(";"); }
        append("using Text=string;struct P{Text s;int guard;};static string cell=c%u;"
               "string swap(string s){string old=cell;cell=s;return old;}"
               "P change(P p,string s){p.s=s;p.guard=0;return p;}"
               "int score(string s){int sum=s.length;for(int n=0;n<s.length;n++)sum=sum+int(s[n])*(n+1);return sum;}"
               "int pair(string a,string b){return score(a)*3+score(b);}int index(string s){cell=s;return 0;}"
               "int main(){P p=P{c%u,42};P q=P{c%u,42};int sum=0;", cell, p, q);
        for (unsigned op = 0; op < 24; ++op) {
            unsigned selected = random_number(8);
            switch (random_number(10)) {
            case 0:
                append("q=change(p,c%u);sum=sum+score(p.s)+score(q.s);", selected);
                q = selected; sum += string_score(values[p]) + string_score(values[q]); break;
            case 1:
                append("p.s=c%u;sum=sum+p.s.length;", selected); p = selected; sum += (int32_t)values[p].length; break;
            case 2:
                append("sum=sum+score(swap(p.s))+score(cell);"); sum += string_score(values[cell]) + string_score(values[p]); cell = p; break;
            case 3:
                append("if(p.s==q.s){q.s=c%u;sum++;}else p=q;", selected);
                if (string_model_equal(values[p], values[q])) { q = selected; ++sum; } else p = q;
                break;
            case 4:
                append("if(p.s!=c%u&&swap(q.s)==c%u)sum=sum+2;", selected, selected);
                if (!string_model_equal(values[p], values[selected])) {
                    if (string_model_equal(values[cell], values[selected])) sum += 2;
                    cell = q;
                }
                break;
            case 5:
                append("{const string keep=q.s;p.s=keep;q.s=c%u;sum=sum+score(keep);}", selected);
                p = q; q = selected; sum += string_score(values[p]); break;
            case 6:
                append("{P copy=p;p=change(p,c%u);sum=sum+score(copy.s);}", selected);
                sum += string_score(values[p]); p = selected; break;
            case 7:
                append("p.s=swap(q.s);q.s=c%u;sum=sum+score(p.s);", selected);
                p = cell; cell = q; q = selected; sum += string_score(values[p]); break;
            case 8:
                append("if(cell.length>0)sum=sum+int(cell[index(c%u)]);", selected);
                if (values[cell].length) { sum += values[cell].bytes[0]; cell = selected; } break;
            case 9:
                append("sum=sum+pair(swap(p.s),swap(q.s));");
                sum += string_score(values[cell]) * 3 + string_score(values[p]); cell = q; break;
            }
        }
        append("return sum+score(p.s)+score(q.s)+score(cell);}");
        sum += string_score(values[p]) + string_score(values[q]) + string_score(values[cell]);
        ++string_programs; semantic_case(sum, 0);
    }
    for (unsigned length = 0; length <= 16; ++length) {
        StringModel s = {.length = length};
        for (unsigned j = 0; j < length; ++j) s.bytes[j] = (unsigned char)random_number(256);
        const int32_t indexes[] = {INT32_MIN, -(int32_t)length, -1, 0, (int32_t)length - 1,
                                  (int32_t)length, (int32_t)length + 1, INT32_MAX};
        for (unsigned n = 0; n < sizeof(indexes) / sizeof(*indexes); ++n) {
            source_length = 0;
            append("struct P{string s;};byte read(P p,int n){return p.s[n];}int main(){return int(read(P{");
            string_literal(s); append("},%d));}", indexes[n]);
            bool valid = indexes[n] >= 0 && (uint32_t)indexes[n] < length;
            ++string_programs; semantic_case(valid ? s.bytes[indexes[n]] : 0, valid ? 0 : 70);
        }
    }
}

/* Enumerate (PC, defined-value set) states instead of using the verifier's meet algorithm. */
enum { GRAPH_REGISTERS = 6, GRAPH_SLOTS = 2, GRAPH_CODE = 13, GRAPH_STATES = 1u << (GRAPH_REGISTERS + GRAPH_SLOTS) };
static bool graph_model(const IrFunction *f) {
    bool seen[GRAPH_CODE][GRAPH_STATES] = {{false}};
    uint32_t queue[GRAPH_CODE * GRAPH_STATES], reachable = 0;
    size_t head = 0, tail = 1;
    queue[0] = 0; seen[0][0] = true;
    while (head < tail) {
        uint32_t state = queue[head++], pc = state / GRAPH_STATES, bits = state % GRAPH_STATES, uses = 0;
        Instruction i = f->code[pc];
        switch (i.op) {
        case OP_LOAD:
            uses = 1u << (GRAPH_REGISTERS + i.a);
            if (i.c) uses |= 1u << i.b;
            break;
        case OP_STORE:
            uses = 1u << i.a;
            if (i.c) uses |= (1u << (GRAPH_REGISTERS + i.dst)) | (1u << i.b);
            break;
        case OP_GLOBAL_STORE: uses = 1u << i.a; break;
        case OP_ADD: case OP_STRING_INDEX: uses = (1u << i.a) | (1u << i.b); break;
        case OP_BRANCH: case OP_SWITCH: case OP_RETURN: case OP_TO_BYTE: case OP_TO_INT: case OP_STRING_LENGTH: uses = 1u << i.a; break;
        default: break;
        }
        if ((bits & uses) != uses) return false;
        if (i.op == OP_CONST || i.op == OP_LOAD || i.op == OP_ADD || i.op == OP_GLOBAL_LOAD || i.op == OP_TO_BYTE || i.op == OP_TO_INT ||
            i.op == OP_STRING_LENGTH || i.op == OP_STRING_INDEX) {
            reachable |= 1u << i.dst; bits |= 1u << i.dst;
        }
        if (i.op == OP_CLEAR || (i.op == OP_STORE && !i.c)) bits |= 1u << (GRAPH_REGISTERS + i.dst);
        uint32_t next[3]; unsigned count = 0;
        if (i.op == OP_JUMP) next[count++] = i.a;
        else if (i.op == OP_BRANCH) { next[count++] = i.b; next[count++] = i.c; }
        else if (i.op == OP_SWITCH) {
            if (i.dst != L_NONE) next[count++] = i.dst;
            for (uint32_t j = i.b; j < i.b + i.c; ++j) next[count++] = f->switch_entries[j].target;
        } else if (i.op != OP_RETURN) next[count++] = pc + 1;
        for (unsigned j = 0; j < count; ++j) {
            if (!seen[next[j]][bits]) {
                seen[next[j]][bits] = true;
                queue[tail++] = next[j] * GRAPH_STATES + bits;
            }
        }
    }
    return reachable == (1u << GRAPH_REGISTERS) - 1;
}
static Instruction ins(Opcode op, uint32_t dst, uint32_t a, uint32_t b, uint32_t c) {
    return (Instruction){op, dst, a, b, c, 1, 1};
}
static void graph_check(const Program *p, bool valid, bool serialized) {
    Context *ctx = context("fuzz-graph");
    if (!setjmp(ctx->failure)) {
        if (serialized) (void)roundtrip(ctx, p); else verify(ctx, p);
    }
    if (ctx->status != (valid ? 0 : 65)) failed("verifier differs from the independent path model");
    dispose(ctx);
}
static void graph_case(const Program *p, bool valid) {
    ++graphs; if (valid) ++valid_graphs; else ++invalid_graphs;
    fprintf(stderr, "verifier graph %zu: expected %s\n", graphs, valid ? "acceptance" : "rejection");
    inspect(p, stderr);
    graph_check(p, valid, false); graph_check(p, valid, true);
}
static void graph_cases(void) {
    for (unsigned test = 0; test < MODEL_CASES * 4; ++test) {
        Type slots[] = {TY_INT, TY_INT}, registers[] = {TY_BOOL, TY_INT, TY_INT, TY_INT, TY_INT, TY_INT};
        uint32_t lengths[] = {0, 1};
        SwitchEntry entries[6];
        IrGlobal globals[] = {{"a", TY_INT, 0}, {"b", TY_INT, 42}};
        Instruction code[] = {
            ins(OP_CONST, 0, 1, 0, 0), ins(OP_CONST, 1, 42, 0, 0), ins(OP_JUMP, 0, 3, 0, 0),
            ins(OP_STORE, 0, 1, 0, 0), ins(OP_CLEAR, 1, 0, 0, 0), ins(OP_CONST, 2, 0, 0, 0),
            ins(OP_JUMP, 0, 7, 0, 0), ins(OP_LOAD, 3, 0, 0, 0), ins(OP_STORE, 1, 1, 2, 1),
            ins(OP_LOAD, 4, 1, 2, 1), ins(OP_ADD, 5, 3, 4, 0), ins(OP_JUMP, 0, 12, 0, 0),
            ins(OP_RETURN, 0, 5, 0, 0)
        };
        if (random_number(2)) code[7] = ins(OP_GLOBAL_LOAD, 3, 0, 0, 0);
        if (random_number(2)) code[8] = ins(OP_GLOBAL_STORE, 1, 1 + random_number(5), 0, 0);
        if (random_number(2)) code[9] = ins(OP_GLOBAL_LOAD, 4, 1, 0, 0);
        IrFunction f = {.name = "main", .result = TY_INT, .slot_count = GRAPH_SLOTS, .register_count = GRAPH_REGISTERS,
            .code_count = GRAPH_CODE, .slots = slots, .registers = registers, .slot_lengths = lengths,
            .code = code, .switch_entries = entries};
        static const unsigned forks[] = {2, 6, 11};
        for (unsigned j = 0; j < 3; ++j) {
            unsigned pc = forks[j], kind = random_number(4), target = random_number(GRAPH_CODE);
            if (kind == 1) code[pc] = ins(OP_JUMP, 0, target, 0, 0);
            if (kind == 2) code[pc] = ins(OP_BRANCH, 0, 0, pc + 1, target);
            if (kind == 3) {
                unsigned count = random_number(3);
                code[pc] = ins(OP_SWITCH, random_number(3) ? pc + 1 : L_NONE, 1, f.switch_count, count);
                for (unsigned k = 0; k < count; ++k)
                    entries[f.switch_count++] = (SwitchEntry){(int32_t)k, random_number(GRAPH_CODE)};
            }
        }
        bool valid = graph_model(&f);
        Program p = {.function_count = 1, .functions = &f, .global_count = 2, .globals = globals}; graph_case(&p, valid);
        /* Same arbitrary CFG, now with byte conversions, arrays and shared cells. */
        slots[0] = slots[1] = registers[3] = registers[4] = TY_BYTE;
        globals[0].type = globals[1].type = TY_BYTE;
        code[3] = ins(OP_TO_BYTE, 3, random_number(2) ? 1 : 5, 0, 0);
        code[7] = ins(OP_STORE, 0, 3, 0, 0);
        code[8] = random_number(2) ? ins(OP_GLOBAL_STORE, 1, 3 + random_number(2), 0, 0) : ins(OP_STORE, 1, 3, 2, 1);
        code[9] = random_number(2) ? ins(OP_GLOBAL_LOAD, 4, 1, 0, 0) : ins(OP_LOAD, 4, 1, 2, 1);
        code[10] = ins(OP_TO_INT, 5, random_number(2) ? 3 : 4, 0, 0);
        graph_case(&p, graph_model(&f));
        /* String operations and scalar string storage on the same verification-only CFG. */
        IrString strings[] = {{0, (const unsigned char *)""}, {1, (const unsigned char *)"*"}};
        p.string_count = 2; p.strings = strings;
        globals[0].type = globals[1].type = slots[0] = slots[1] = registers[2] = registers[4] = TY_STRING;
        globals[1].initial = 1; lengths[1] = 0; code[1].a = 0;
        code[3] = ins(OP_CONST, 2, 1, 0, 0); code[4] = ins(OP_STORE, 1, 2, 0, 0);
        code[5] = ins(OP_STRING_INDEX, 3, 2, random_number(2) ? 1 : 5, 0);
        code[7] = ins(OP_STORE, 0, 2, 0, 0);
        code[8] = random_number(2) ? ins(OP_GLOBAL_STORE, 1, random_number(2) ? 2 : 4, 0, 0) : ins(OP_STORE, 1, 2, 0, 0);
        code[9] = random_number(2) ? ins(OP_GLOBAL_LOAD, 4, 1, 0, 0) : ins(OP_LOAD, 4, 1, 0, 0);
        code[10] = ins(OP_STRING_LENGTH, 5, random_number(2) ? 2 : 4, 0, 0);
        graph_case(&p, graph_model(&f));
    }
    if (!valid_graphs || !invalid_graphs) failed("graph model did not exercise acceptance and rejection");
}

int main(void) {
    if (!freopen("build/fuzz.log", "w", stderr)) { puts("fuzz: cannot open build/fuzz.log"); return 1; }
    setvbuf(stderr, NULL, _IONBF, 0);
    fprintf(stderr, "Deterministic fuzz seed: 0x%08x\n", FUZZ_SEED);
    fuzz_bytecode();
    random_state = FUZZ_SEED;
    model_cases();
    bounds_cases();
    switch_cases();
    switch_loop_cases();
    switch_limit_cases();
    expression_cases();
    static_cases();
    static_lifecycle_cases();
    graph_cases();
    shape_cases();
    struct_cases();
    enum_cases();
    byte_cases();
    string_cases();
    remove("build/fuzz-roundtrip.lbc");
    printf("fuzz: %zu bytecode inputs (%zu accepted, %zu rejected); %zu semantic programs, %zu VM executions passed\n",
           inputs, accepted, rejected, programs, executions);
    printf("fuzz: %zu verifier graphs (%zu accepted, %zu rejected) matched the independent path model\n",
           graphs, valid_graphs, invalid_graphs);
    printf("fuzz: %zu static lifecycle programs preserved initializers across traps, cleanup and retries\n", lifecycle_programs);
    printf("fuzz: %zu constant-shape programs matched independent lengths, dispatch and bounds models\n", shape_programs);
    printf("fuzz: %zu struct programs matched independent copy, field and call models\n", struct_programs);
    printf("fuzz: %zu enum programs matched independent value, dispatch and state models\n", enum_programs);
    printf("fuzz: %zu byte programs matched independent storage, conversion and state models\n", byte_programs);
    printf("fuzz: %zu string programs matched independent byte, equality, bounds and state models\n", string_programs);
    return 0;
}
