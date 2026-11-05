#include "../bootstrap/stage0/l.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    Program program;
    IrFunction functions[2];
    Type registers[2][9], slots[2][1];
    uint32_t lengths[2][1], arguments[1];
    Instruction code[2][15];
    SwitchEntry entries[3];
    IrGlobal global;
} Fixture;
typedef struct { VmEvent events[1024]; size_t count, seen; const Program *program; } Trace;
static size_t cases;
static Trace *null_trace;

static _Noreturn void failed(const char *message) {
    fprintf(stderr, "observer: %s\n", message); exit(1);
}
static Context *context(void) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) failed("cannot allocate context");
    ctx->filename = "observer-test"; return ctx;
}
static Instruction ins(Opcode op, uint32_t dst, uint32_t a, uint32_t b, uint32_t c) {
    return (Instruction){op, dst, a, b, c, 1, 1};
}
static void event(Trace *trace, VmEventKind kind, uint32_t function, uint32_t pc, uint32_t arm) {
    if (trace->count == sizeof(trace->events) / sizeof(*trace->events)) failed("model trace exceeds buffer");
    trace->events[trace->count++] = (VmEvent){kind, function, pc, arm};
}
static void step(Trace *trace, uint32_t function, uint32_t pc) { event(trace, VM_INSTRUCTION, function, pc, L_NONE); }
static void record(void *data, VmEvent actual) {
    Trace *trace = data;
    if (!trace || trace->seen == trace->count) failed("unexpected callback or extra event");
    VmEvent expected = trace->events[trace->seen++];
    if (actual.kind != expected.kind || actual.function != expected.function || actual.pc != expected.pc || actual.arm != expected.arm) {
        fprintf(stderr, "observer event %zu: expected (%d,%u,%u,%u), got (%d,%u,%u,%u)\n", trace->seen,
            expected.kind, expected.function, expected.pc, expected.arm, actual.kind, actual.function, actual.pc, actual.arm);
        failed("trace differs from independent model");
    }
    if (actual.function >= trace->program->function_count || actual.pc >= trace->program->functions[actual.function].code_count)
        failed("event position is outside program");
}
static void record_null(void *data, VmEvent actual) {
    if (data) failed("NULL observer data was not preserved");
    record(null_trace, actual);
}
static void execute(Context *ctx, const Program *p, FILE *input, FILE *output, FILE *error,
                    VmObserver observer, void *data, int32_t expected, int status) {
    ctx->filename = "observer-execution"; ctx->status = 0;
    if (ctx->allocated || ctx->allocations) failed("execution context was not clean");
    if (!setjmp(ctx->failure)) {
        if (execute_program_observed(ctx, p, input, output, error, observer, data) != expected)
            failed("observed result differs from unobserved model");
    }
    if (ctx->status != status) failed("unexpected execution status");
    if (!status && (ctx->allocated || ctx->allocations)) failed("successful execution retained memory");
    cleanup(ctx);
    if (ctx->allocated || ctx->allocations) failed("trap cleanup retained memory");
}
static void reset(Fixture *x, unsigned limit) {
    memset(x, 0, sizeof(*x));
    x->global = (IrGlobal){"weight", TY_INT, 0, 0};
    x->program = (Program){.function_count = 2, .functions = x->functions, .global_count = 1, .globals = &x->global};
    for (unsigned n = 0; n < 2; ++n) {
        IrFunction *f = &x->functions[n];
        f->name = n ? "helper" : "main"; f->source_path = n ? "observer-helper.l" : "observer-main.l";
        f->result = TY_INT; f->slots = x->slots[n]; f->slot_lengths = x->lengths[n]; f->registers = x->registers[n];
        f->code = x->code[n]; f->arguments = x->arguments; f->switch_entries = x->entries;
        f->slot_count = 1; x->slots[n][0] = TY_INT;
        for (unsigned r = 0; r < 9; ++r) x->registers[n][r] = TY_INT;
    }
    IrFunction *f = &x->functions[0], *g = &x->functions[1];
    f->register_count = 9; f->code_count = 15; f->argument_count = 1; x->arguments[0] = 1;
    x->registers[0][3] = TY_BOOL;
    x->code[0][0] = ins(OP_CONST, 0, 0, 0, 0);
    x->code[0][1] = ins(OP_STORE, 0, 0, 0, 0);
    x->code[0][2] = ins(OP_LOAD, 1, 0, 0, 0);
    x->code[0][3] = ins(OP_CONST, 2, limit, 0, 0);
    x->code[0][4] = ins(OP_LT, 3, 1, 2, 0);
    x->code[0][5] = ins(OP_BRANCH, 0, 3, 6, 12);
    x->code[0][6] = ins(OP_CALL, 4, 1, 0, 1);
    x->code[0][7] = ins(OP_CONST, 5, 1, 0, 0);
    x->code[0][8] = ins(OP_ADD, 6, 1, 5, 0);
    x->code[0][9] = ins(OP_STORE, 0, 6, 0, 0);
    x->code[0][10] = ins(OP_GLOBAL_STORE, 0, 4, 0, 0);
    x->code[0][11] = ins(OP_JUMP, 0, 2, 0, 0);
    x->code[0][12] = ins(OP_GLOBAL_LOAD, 7, 0, 0, 0);
    x->code[0][13] = ins(OP_ADD, 8, 1, 7, 0);
    x->code[0][14] = ins(OP_RETURN, 0, 8, 0, 0);
    g->parameter_count = 1; g->register_count = 4; g->code_count = 8; g->switch_count = 3;
    x->entries[0] = (SwitchEntry){999, 0}; /* Unused prefix: event arms are vector-relative. */
    x->entries[1] = (SwitchEntry){0, 2}; x->entries[2] = (SwitchEntry){2, 4};
    x->code[1][0] = ins(OP_LOAD, 0, 0, 0, 0);
    x->code[1][1] = ins(OP_SWITCH, 6, 0, 1, 2);
    for (unsigned n = 0; n < 3; ++n) {
        x->code[1][2 + n * 2] = ins(OP_CONST, n + 1, (n + 1) * 100, 0, 0);
        x->code[1][3 + n * 2] = ins(OP_RETURN, 0, n + 1, 0, 0);
    }
}
static Program *load(Context *owner, Program *p, bool serialized) {
    verify(owner, p);
    if (!serialized) return p;
    write_bytecode(owner, p, "build/observer.lbc");
    size_t size; unsigned char *bytes = read_file(owner, "build/observer.lbc", &size);
    return read_bytecode(owner, bytes, size);
}
enum { NORMAL, TRAP, DIVIDE, SWITCH_TRAP, SHARED_SWITCH };
static int32_t model(Trace *trace, unsigned limit, int mode) {
    int32_t weight = 0;
    step(trace, 0, 0); step(trace, 0, 1);
    for (unsigned n = 0; n <= limit; ++n) {
        for (unsigned pc = 2; pc <= 5; ++pc) step(trace, 0, pc);
        event(trace, VM_BRANCH, 0, 5, n < limit ? 0 : 1);
        if (n == limit) break;
        step(trace, 0, 6); step(trace, 1, 0); step(trace, 1, 1);
        unsigned arm = n == 0 ? 0 : n == 2 ? 1 : 2;
        event(trace, VM_BRANCH, 1, 1, arm);
        if (mode == SWITCH_TRAP && arm == 2) return 0;
        unsigned pc = mode == SHARED_SWITCH ? (arm < 2 ? 2 : 4) : 2 + arm * 2;
        weight = mode == SHARED_SWITCH && arm < 2 ? 100 : (int32_t)(arm + 1) * 100;
        step(trace, 1, pc); step(trace, 1, pc + 1);
        for (unsigned next = 7; next <= 11; ++next) step(trace, 0, next);
    }
    step(trace, 0, 12);
    if (mode == TRAP || mode == DIVIDE) return 0;
    step(trace, 0, 13); step(trace, 0, 14);
    return (int32_t)limit + weight;
}
static void check_model(unsigned limit, int mode, bool serialized) {
    Context *owner = context(); if (setjmp(owner->failure)) failed("model program was rejected");
    Fixture x; reset(&x, limit);
    if (mode == TRAP || mode == DIVIDE) {
        x.functions[0].register_count = mode == TRAP ? 7 : 8;
        x.functions[0].code_count = mode == TRAP ? 13 : 14;
        x.code[0][12] = ins(mode == TRAP ? OP_TRAP : OP_DIV, 7, 1, 0, 0);
        x.code[0][13] = ins(OP_RETURN, 0, 7, 0, 0);
    }
    if (mode == SWITCH_TRAP) {
        x.code[1][1].dst = L_NONE; x.functions[1].register_count = 3; x.functions[1].code_count = 6;
    }
    if (mode == SHARED_SWITCH) {
        x.entries[2].target = 2; x.code[1][1].dst = 4; x.functions[1].register_count = 3; x.functions[1].code_count = 6;
        x.code[1][4] = ins(OP_CONST, 2, 300, 0, 0); x.code[1][5] = ins(OP_RETURN, 0, 2, 0, 0);
    }
    Program *p = load(owner, &x.program, serialized);
    Trace trace = {.program = p}; int32_t result = model(&trace, limit, mode);
    int status = mode == NORMAL || mode == SHARED_SWITCH ? 0 : 70;
    Context *execution = context();
    write_bytecode(owner, p, "build/observer.lbc");
    size_t before_size; unsigned char *before = read_file(owner, "build/observer.lbc", &before_size);
    execute(execution, p, stdin, stdout, stderr, record, &trace, result, status);
    if (trace.seen != trace.count) failed("trace ended before model");
    trace.seen = 0;
    execute(execution, p, stdin, stdout, stderr, NULL, &trace, result, status);
    if (trace.seen) failed("disabled observer received events");
    execute(execution, p, stdin, stdout, stderr, record, &trace, result, status);
    if (trace.seen != trace.count || p->globals[0].initial) failed("trace or initializer state leaked across executions");
    write_bytecode(owner, p, "build/observer.lbc");
    size_t after_size; unsigned char *after = read_file(owner, "build/observer.lbc", &after_size);
    if (before_size != after_size || memcmp(before, after, before_size)) failed("observer changed serialized program");
    cleanup(execution); free(execution); cleanup(owner); free(owner); ++cases;
}
static void check_null(bool serialized) {
    Context *owner = context(); if (setjmp(owner->failure)) failed("NULL-data program rejected");
    Fixture x; reset(&x, 3); Program *p = load(owner, &x.program, serialized);
    Trace trace = {.program = p}; int32_t result = model(&trace, 3, NORMAL); null_trace = &trace;
    Context *execution = context(); execute(execution, p, stdin, stdout, stderr, record_null, NULL, result, 0);
    if (trace.seen != trace.count) failed("NULL-data observer missed events");
    null_trace = NULL; cleanup(execution); free(execution); cleanup(owner); free(owner); ++cases;
}
static void check_same_target(unsigned condition, bool serialized) {
    Context *owner = context(); if (setjmp(owner->failure)) failed("same-target branch rejected");
    Fixture x; reset(&x, 0); x.program.function_count = 1; x.program.global_count = 0;
    IrFunction *f = &x.functions[0]; f->slot_count = f->argument_count = 0; f->register_count = 3; f->code_count = 5;
    x.registers[0][2] = TY_BOOL;
    x.code[0][0] = ins(OP_CONST, 0, 0, 0, 0); x.code[0][1] = ins(OP_CONST, 1, condition, 0, 0);
    x.code[0][2] = ins(OP_LT, 2, 0, 1, 0); x.code[0][3] = ins(OP_BRANCH, 0, 2, 4, 4);
    x.code[0][4] = ins(OP_RETURN, 0, 0, 0, 0);
    Program *p = load(owner, &x.program, serialized); Trace trace = {.program = p};
    for (unsigned pc = 0; pc < 4; ++pc) step(&trace, 0, pc);
    event(&trace, VM_BRANCH, 0, 3, condition ? 0 : 1); step(&trace, 0, 4);
    Context *execution = context(); execute(execution, p, stdin, stdout, stderr, record, &trace, 0, 0);
    if (trace.seen != trace.count) failed("same-target branch lost its outcome");
    cleanup(execution); free(execution); cleanup(owner); free(owner); ++cases;
}
static void check_empty_switch(bool trap, bool serialized) {
    Context *owner = context(); if (setjmp(owner->failure)) failed("empty switch rejected");
    Fixture x; reset(&x, 0); x.program.function_count = 1; x.program.global_count = 0;
    IrFunction *f = &x.functions[0]; f->slot_count = f->argument_count = 0; f->register_count = 1; f->code_count = trap ? 2 : 3;
    x.code[0][0] = ins(OP_CONST, 0, 42, 0, 0);
    x.code[0][1] = ins(OP_SWITCH, trap ? L_NONE : 2, 0, 0, 0); x.code[0][2] = ins(OP_RETURN, 0, 0, 0, 0);
    Program *p = load(owner, &x.program, serialized); Trace trace = {.program = p};
    step(&trace, 0, 0); step(&trace, 0, 1); event(&trace, VM_BRANCH, 0, 1, 0);
    if (!trap) step(&trace, 0, 2);
    Context *execution = context(); execute(execution, p, stdin, stdout, stderr, record, &trace, 42, trap ? 70 : 0);
    if (trace.seen != trace.count) failed("empty switch lost its fallback event");
    cleanup(execution); free(execution); cleanup(owner); free(owner); ++cases;
}
enum { READ_VALUE, READ_EOF, READ_ERROR, WRITE_VALUE, WRITE_BUFFERED, WRITE_UNBUFFERED };
static void check_io(unsigned mode, bool serialized) {
    Context *owner = context(); if (setjmp(owner->failure)) failed("stream program rejected");
    Fixture x; reset(&x, 0); x.program.function_count = 1; x.program.global_count = 0;
    IrFunction *f = &x.functions[0]; f->slot_count = f->argument_count = 0;
    if (mode < WRITE_VALUE) {
        f->register_count = 1; f->code_count = 2;
        x.code[0][0] = ins(OP_READ_BYTE, 0, 0, 0, 0); x.code[0][1] = ins(OP_RETURN, 0, 0, 0, 0);
    } else {
        f->register_count = 2; f->code_count = 4; x.registers[0][0] = TY_BYTE;
        x.code[0][0] = ins(OP_CONST, 0, 255, 0, 0); x.code[0][1] = ins(OP_WRITE_BYTE, L_NONE, 0, 0, 0);
        x.code[0][2] = ins(OP_CONST, 1, 42, 0, 0); x.code[0][3] = ins(OP_RETURN, 0, 1, 0, 0);
    }
    Program *p = load(owner, &x.program, serialized); Trace trace = {.program = p};
    unsigned count = mode == READ_ERROR ? 1 : mode >= WRITE_BUFFERED ? 2 : f->code_count;
    for (unsigned pc = 0; pc < count; ++pc) step(&trace, 0, pc);
    FILE *input = mode == READ_ERROR ? fopen(".", "rb") : tmpfile();
    FILE *output = mode >= WRITE_BUFFERED ? fopen("/dev/full", "wb") : tmpfile(), *error = tmpfile();
    if (!input || !output || !error) failed("cannot open stream fixture");
    if (mode == READ_VALUE) { if (fputc(255, input) == EOF) failed("cannot seed input"); rewind(input); }
    if (mode >= WRITE_BUFFERED && setvbuf(output, NULL, mode == WRITE_UNBUFFERED ? _IONBF : _IOFBF, BUFSIZ)) failed("cannot set buffering");
    int status = mode == READ_ERROR || mode >= WRITE_BUFFERED ? 70 : 0;
    int32_t value = mode == READ_VALUE ? 255 : mode == READ_EOF ? -1 : 42;
    Context *execution = context(); execute(execution, p, input, output, error, record, &trace, value, status);
    if (trace.seen != trace.count) failed("stream trap emitted missing or post-trap events");
    if (mode == READ_ERROR && !ferror(input)) failed("observer cleared input error");
    if (mode >= WRITE_BUFFERED) { if (!ferror(output)) failed("observer cleared output error"); }
    else {
        rewind(output);
        if (mode == WRITE_VALUE && fgetc(output) != 255) failed("observer changed output byte");
        if (fgetc(output) != EOF || ferror(output)) failed("unexpected stream output");
    }
    rewind(error); if (fgetc(error) != EOF || ferror(error)) failed("observer wrote to program stderr");
    fclose(input); fclose(output); fclose(error);
    cleanup(execution); free(execution); cleanup(owner); free(owner); ++cases;
}
typedef struct { uint64_t instructions, branches, max_instructions, max_branches; VmEvent last; } Count;
static void count_events(void *data, VmEvent event) {
    Count *count = data; count->last = event;
    if (event.function || (event.kind == VM_INSTRUCTION && event.arm != L_NONE)) failed("invalid limit-test event");
    if (event.kind == VM_INSTRUCTION) ++count->instructions; else ++count->branches;
    if (count->instructions > count->max_instructions || count->branches > count->max_branches)
        failed("observer changed the instruction/depth limit");
}
static void check_limit(bool depth, bool serialized) {
    Context *owner = context(); if (setjmp(owner->failure)) failed("limit program rejected");
    Fixture x; reset(&x, 0); x.program.function_count = 1; x.program.global_count = 0;
    IrFunction *f = &x.functions[0]; f->slot_count = f->argument_count = 0;
    if (depth) {
        f->register_count = 1; f->code_count = 2;
        x.code[0][0] = ins(OP_CALL, 0, 0, 0, 0); x.code[0][1] = ins(OP_RETURN, 0, 0, 0, 0);
    } else {
        f->register_count = 2; f->code_count = 4; x.registers[0][0] = TY_BOOL;
        x.code[0][0] = ins(OP_CONST, 0, 1, 0, 0); x.code[0][1] = ins(OP_CONST, 1, 42, 0, 0);
        x.code[0][2] = ins(OP_BRANCH, 0, 0, 2, 3); x.code[0][3] = ins(OP_RETURN, 0, 1, 0, 0);
    }
    Program *p = load(owner, &x.program, serialized);
    Count count = {.max_instructions = depth ? L_MAX_DEPTH : L_MAX_STEPS, .max_branches = depth ? 0 : L_MAX_STEPS - 2};
    Context *execution = context(); execute(execution, p, stdin, stdout, stderr, count_events, &count, 0, 70);
    if (count.instructions != count.max_instructions || count.branches != count.max_branches ||
        count.last.kind != (depth ? VM_INSTRUCTION : VM_BRANCH) || count.last.pc != (depth ? 0 : 2) ||
        count.last.arm != (depth ? L_NONE : 0)) failed("events included a rejected instruction or callee");
    cleanup(execution); free(execution); cleanup(owner); free(owner); ++cases;
}

int main(void) {
    for (unsigned serialized = 0; serialized < 2; ++serialized) {
        for (unsigned n = 0; n <= 16; ++n)
            for (int mode = NORMAL; mode <= DIVIDE; ++mode) check_model(n, mode, serialized != 0);
        check_model(3, SWITCH_TRAP, serialized != 0); check_model(4, SHARED_SWITCH, serialized != 0);
        check_null(serialized != 0);
        check_same_target(0, serialized != 0); check_same_target(1, serialized != 0);
        check_empty_switch(false, serialized != 0); check_empty_switch(true, serialized != 0);
        for (unsigned mode = READ_VALUE; mode <= WRITE_UNBUFFERED; ++mode) check_io(mode, serialized != 0);
        check_limit(false, serialized != 0); check_limit(true, serialized != 0);
    }
    remove("build/observer.lbc");
    printf("observer: %zu trace, stream and limit cases passed\n", cases);
    return 0;
}
