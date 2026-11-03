#include "../bootstrap/stage0/l.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    Program program;
    IrFunction functions[2];
    Type slots[2][4], registers[2][8];
    Instruction code[2][12];
    uint32_t arguments[4];
    uint32_t slot_lengths[2][4];
} Fixture;

static Instruction ins(Opcode op, uint32_t dst, uint32_t a, uint32_t b, uint32_t c) {
    return (Instruction){op, dst, a, b, c, 1, 1};
}
static void reset(Fixture *x) {
    memset(x, 0, sizeof(*x));
    x->program = (Program){2, 0, x->functions};
    for (unsigned j = 0; j < 2; ++j) {
        x->functions[j].name = j ? "helper" : "main";
        x->functions[j].slots = x->slots[j];
        x->functions[j].slot_lengths = x->slot_lengths[j];
        x->functions[j].registers = x->registers[j];
        x->functions[j].code = x->code[j];
        x->functions[j].arguments = x->arguments;
    }
    x->functions[0].result = TY_INT;
    x->functions[0].slot_count = 2;
    x->slots[0][0] = TY_INT; x->slots[0][1] = TY_BOOL;
    x->functions[0].register_count = 1; x->registers[0][0] = TY_INT;
    x->functions[0].code_count = 2;
    x->code[0][0] = ins(OP_CONST, 0, 42, 0, 0);
    x->code[0][1] = ins(OP_RETURN, 0, 0, 0, 0);
    x->functions[1].result = TY_VOID; x->functions[1].code_count = 1;
    x->code[1][0] = ins(OP_RETURN, 0, L_NONE, 0, 0);
}

enum {
    VALID, NO_FUNCTIONS, MANY_FUNCTIONS, BAD_ENTRY, ENTRY_TYPE, ENTRY_PARAMS,
    RESULT_TYPE, PARAM_LIMIT, SLOT_LIMIT, REGISTER_LIMIT, NO_CODE, CODE_LIMIT, ARGUMENT_LIMIT,
    SLOT_TYPE, REGISTER_TYPE, OPCODE, REGISTER_INDEX, SLOT_INDEX, MISMATCH,
    DUPLICATE, UNDEFINED, BOOL_CONSTANT, STORE_MISMATCH, CALLEE_INDEX, CALL_ARITY,
    CALL_OFFSET, CALL_RANGE, VOID_CALL_VALUE, VOID_RETURN_VALUE, NONVOID_CALL_NONE,
    ARGUMENT_TYPE, ARGUMENT_INDEX, JUMP_RANGE, FALL_OFF, UNINITIALIZED, NOT_DOMINATING,
    DIAMOND, BAD_DIAMOND, UNREACHABLE, LOAD_STORE, VM_BAD_OPCODE,
    ARRAY_VALID, ARRAY_NOCHECK, ARRAY_LENGTH, ARRAY_TOTAL, ARRAY_PARAMETER,
    ARRAY_LOAD_MODE, ARRAY_STORE_MODE, ARRAY_LOAD_SCALAR, ARRAY_STORE_SCALAR,
    ARRAY_LOAD_WHOLE, ARRAY_STORE_WHOLE, ARRAY_INDEX_RANGE, ARRAY_INDEX_TYPE,
    ARRAY_STORE_INDEX_TYPE, ARRAY_BOUNDS_ZERO, ARRAY_BOUNDS_LARGE, ARRAY_CLEAR_SCALAR,
    ARRAY_LOAD_UNINITIALIZED, ARRAY_STORE_UNINITIALIZED, ARRAY_LOAD_UNDEFINED_INDEX,
    ARRAY_STORE_UNDEFINED_INDEX, ARRAY_BOUNDS_UNDEFINED_INDEX,
    ARRAY_VM_LOAD_OOB, ARRAY_VM_LOAD_NEGATIVE, ARRAY_VM_STORE_OOB, ARRAY_VM_STORE_NEGATIVE,
    CASE_COUNT
};

static void array_fixture(Fixture *x) {
    IrFunction *f = &x->functions[0];
    x->slot_lengths[0][0] = 2;
    f->register_count = 3;
    for (unsigned j = 0; j < 3; ++j) x->registers[0][j] = TY_INT;
    f->code_count = 7;
    x->code[0][0] = ins(OP_CLEAR, 0, 0, 0, 0);
    x->code[0][1] = ins(OP_CONST, 0, 0, 0, 0);
    x->code[0][2] = ins(OP_CONST, 1, 42, 0, 0);
    x->code[0][3] = ins(OP_BOUNDS, 0, 0, 0, 2);
    x->code[0][4] = ins(OP_STORE, 0, 1, 0, 1);
    x->code[0][5] = ins(OP_LOAD, 2, 0, 0, 1);
    x->code[0][6] = ins(OP_RETURN, 0, 2, 0, 0);
}

static void mutate(Fixture *x, int which) {
    IrFunction *f = &x->functions[0], *g = &x->functions[1];
    if (which >= ARRAY_VALID) array_fixture(x);
    switch (which) {
    case VALID: break;
    case NO_FUNCTIONS: x->program.function_count = 0; break;
    case MANY_FUNCTIONS: x->program.function_count = L_MAX_FUNCTIONS + 1; break;
    case BAD_ENTRY: x->program.entry = 2; break;
    case ENTRY_TYPE: f->result = TY_BOOL; break;
    case ENTRY_PARAMS: f->parameter_count = 1; break;
    case RESULT_TYPE: g->result = TY_AUTO; break;
    case PARAM_LIMIT: g->parameter_count = 1; break;
    case SLOT_LIMIT: g->slot_count = L_MAX_SLOTS + 1; break;
    case REGISTER_LIMIT: g->register_count = L_MAX_REGISTERS + 1; break;
    case NO_CODE: g->code_count = 0; break;
    case CODE_LIMIT: g->code_count = L_MAX_CODE + 1; break;
    case ARGUMENT_LIMIT: g->argument_count = L_MAX_ARGS + 1; break;
    case SLOT_TYPE: x->slots[0][0] = TY_VOID; break;
    case REGISTER_TYPE: x->registers[0][0] = TY_VOID; break;
    case OPCODE: case VM_BAD_OPCODE: x->code[0][0].op = OP_COUNT; break;
    case REGISTER_INDEX: x->code[0][0].dst = 1; break;
    case SLOT_INDEX: x->code[0][0] = ins(OP_LOAD, 0, 2, 0, 0); break;
    case MISMATCH: x->registers[0][0] = TY_BOOL; x->code[0][0].a = 0; break;
    case DUPLICATE:
        f->code_count = 3;
        x->code[0][2] = x->code[0][1]; x->code[0][1] = x->code[0][0]; break;
    case UNDEFINED: f->register_count = 2; x->registers[0][1] = TY_INT; break;
    case BOOL_CONSTANT: x->registers[0][0] = TY_BOOL; break;
    case STORE_MISMATCH:
        f->code_count = 3; x->code[0][2] = x->code[0][1];
        x->code[0][1] = ins(OP_STORE, 1, 0, 0, 0); break;
    case CALLEE_INDEX: x->code[0][0] = ins(OP_CALL, 0, 2, 0, 0); break;
    case CALL_ARITY: x->code[0][0] = ins(OP_CALL, L_NONE, 1, 0, 1); break;
    case CALL_OFFSET: x->code[0][0] = ins(OP_CALL, L_NONE, 1, 1, 0); break;
    case CALL_RANGE:
        g->parameter_count = g->slot_count = 1; x->slots[1][0] = TY_INT;
        x->code[0][0] = ins(OP_CALL, L_NONE, 1, 0, 1); break;
    case VOID_CALL_VALUE: x->code[0][0] = ins(OP_CALL, 0, 1, 0, 0); break;
    case VOID_RETURN_VALUE: x->code[1][0].a = 0; break;
    case NONVOID_CALL_NONE: x->code[0][0] = ins(OP_CALL, L_NONE, 0, 0, 0); break;
    case ARGUMENT_TYPE: case ARGUMENT_INDEX:
        g->parameter_count = g->slot_count = 1; x->slots[1][0] = TY_BOOL;
        f->argument_count = 1; x->arguments[0] = which == ARGUMENT_INDEX ? 99 : 0;
        f->code_count = 3; x->code[0][2] = x->code[0][1];
        x->code[0][1] = ins(OP_CALL, L_NONE, 1, 0, 1); break;
    case JUMP_RANGE: x->code[0][0] = ins(OP_JUMP, 0, 99, 0, 0); break;
    case FALL_OFF:
        f->register_count = 2; x->registers[0][1] = TY_INT;
        x->code[0][1] = ins(OP_CONST, 1, 42, 0, 0); break;
    case UNINITIALIZED: x->code[0][0] = ins(OP_LOAD, 0, 0, 0, 0); break;
    case NOT_DOMINATING:
        f->register_count = 2; x->registers[0][1] = TY_INT; f->code_count = 3;
        x->code[0][0] = ins(OP_NEG, 0, 1, 0, 0);
        x->code[0][1] = ins(OP_CONST, 1, 42, 0, 0);
        x->code[0][2] = ins(OP_RETURN, 0, 0, 0, 0); break;
    case DIAMOND: case BAD_DIAMOND:
        f->register_count = 4; x->registers[0][0] = TY_BOOL;
        for (unsigned j = 1; j < 4; ++j) x->registers[0][j] = TY_INT;
        f->code_count = 8;
        x->code[0][0] = ins(OP_CONST, 0, 1, 0, 0);
        x->code[0][1] = ins(OP_BRANCH, 0, 0, 2, 4);
        x->code[0][2] = ins(OP_CONST, 1, 1, 0, 0);
        x->code[0][3] = ins(OP_JUMP, 0, 6, 0, 0);
        x->code[0][4] = ins(OP_CONST, 2, 2, 0, 0);
        x->code[0][5] = ins(OP_JUMP, 0, 6, 0, 0);
        x->code[0][6] = ins(OP_CONST, 3, 42, 0, 0);
        x->code[0][7] = ins(OP_RETURN, 0, which == BAD_DIAMOND ? 1 : 3, 0, 0); break;
    case UNREACHABLE:
        f->register_count = 2; x->registers[0][1] = TY_INT; f->code_count = 4;
        x->code[0][2] = ins(OP_CONST, 1, 9, 0, 0);
        x->code[0][3] = ins(OP_RETURN, 0, 1, 0, 0); break;
    case LOAD_STORE:
        f->register_count = 2; x->registers[0][1] = TY_INT; f->code_count = 4;
        x->code[0][1] = ins(OP_STORE, 0, 0, 0, 0);
        x->code[0][2] = ins(OP_LOAD, 1, 0, 0, 0);
        x->code[0][3] = ins(OP_RETURN, 0, 1, 0, 0); break;
    case ARRAY_VALID: break;
    case ARRAY_NOCHECK: x->code[0][3] = ins(OP_JUMP, 0, 4, 0, 0); break;
    case ARRAY_LENGTH: x->slot_lengths[0][0] = L_MAX_ARRAY + 1; break;
    case ARRAY_TOTAL: x->slot_lengths[0][0] = L_MAX_ARRAY; x->slot_lengths[0][1] = 2; break;
    case ARRAY_PARAMETER:
        g->parameter_count = g->slot_count = 1;
        x->slots[1][0] = TY_INT; x->slot_lengths[1][0] = 1; break;
    case ARRAY_LOAD_MODE: x->code[0][5].c = 2; break;
    case ARRAY_STORE_MODE: x->code[0][4].c = 2; break;
    case ARRAY_LOAD_SCALAR: x->code[0][5].a = 1; break;
    case ARRAY_STORE_SCALAR: x->code[0][4].dst = 1; break;
    case ARRAY_LOAD_WHOLE: x->code[0][5].c = 0; break;
    case ARRAY_STORE_WHOLE: x->code[0][4].c = 0; break;
    case ARRAY_INDEX_RANGE: x->code[0][5].b = 99; break;
    case ARRAY_INDEX_TYPE:
        x->registers[0][1] = TY_BOOL; x->code[0][2].a = 1;
        x->code[0][4] = ins(OP_JUMP, 0, 5, 0, 0);
        x->code[0][5].b = 1; break;
    case ARRAY_STORE_INDEX_TYPE:
        x->registers[0][0] = TY_BOOL;
        x->code[0][3] = ins(OP_JUMP, 0, 4, 0, 0); break;
    case ARRAY_BOUNDS_ZERO: x->code[0][3].c = 0; break;
    case ARRAY_BOUNDS_LARGE: x->code[0][3].c = L_MAX_ARRAY + 1; break;
    case ARRAY_CLEAR_SCALAR: x->code[0][0].dst = 1; break;
    case ARRAY_LOAD_UNINITIALIZED:
        x->code[0][0] = ins(OP_JUMP, 0, 1, 0, 0);
        x->code[0][4] = ins(OP_JUMP, 0, 5, 0, 0); break;
    case ARRAY_STORE_UNINITIALIZED: x->code[0][0] = ins(OP_JUMP, 0, 1, 0, 0); break;
    case ARRAY_LOAD_UNDEFINED_INDEX: x->code[0][5].b = 2; break;
    case ARRAY_STORE_UNDEFINED_INDEX: x->code[0][4].b = 2; break;
    case ARRAY_BOUNDS_UNDEFINED_INDEX: x->code[0][3].a = 2; break;
    case ARRAY_VM_LOAD_OOB: case ARRAY_VM_LOAD_NEGATIVE:
        x->code[0][5].b = 1;
        if (which == ARRAY_VM_LOAD_NEGATIVE) x->code[0][2].a = UINT32_MAX;
        break;
    case ARRAY_VM_STORE_OOB: case ARRAY_VM_STORE_NEGATIVE:
        x->code[0][1].a = which == ARRAY_VM_STORE_OOB ? 2 : UINT32_MAX;
        x->code[0][3] = ins(OP_JUMP, 0, 4, 0, 0); break;
    }
}

static void check(int which) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) exit(1);
    ctx->filename = "verifier-test";
    if (!setjmp(ctx->failure)) {
        Fixture x; reset(&x); mutate(&x, which);
        if (which != VM_BAD_OPCODE) verify(ctx, &x.program);
        Program *program = &x.program;
        if (which >= ARRAY_VALID) {
            write_bytecode(ctx, program, "build/verifier-case.lbc");
            size_t size;
            unsigned char *bytes = read_file(ctx, "build/verifier-case.lbc", &size);
            program = read_bytecode(ctx, bytes, size);
        }
        int32_t result = execute_program(ctx, program);
        if (result != 42) exit(1);
    }
    int expected = which == VALID || which == DIAMOND || which == LOAD_STORE ||
        which == ARRAY_VALID || which == ARRAY_NOCHECK ? 0 : 65;
    if (which == VM_BAD_OPCODE || which >= ARRAY_VM_LOAD_OOB) expected = 70;
    if (ctx->status != expected) { fprintf(stderr, "verifier case %d: expected %d, got %d\n", which, expected, ctx->status); exit(1); }
    cleanup(ctx); free(ctx);
}

static void check_bytes(const unsigned char *bytes, size_t size, bool valid) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) exit(1);
    ctx->filename = "bytecode-test";
    if (!setjmp(ctx->failure)) {
        Program *p = read_bytecode(ctx, bytes, size);
        if (execute_program(ctx, p) != 42) exit(1);
    }
    if ((ctx->status == 0) != valid) { fprintf(stderr, "unexpected bytecode result at length %zu\n", size); exit(1); }
    cleanup(ctx); free(ctx);
}
static void store(unsigned char *bytes, size_t offset, uint32_t value, unsigned width) {
    for (unsigned j = 0; j < width; ++j) bytes[offset + j] = (unsigned char)(value >> (8 * j));
}

int main(void) {
    for (int which = 0; which < CASE_COUNT; ++which) check(which);
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) return 1;
    ctx->filename = "roundtrip-test";
    if (setjmp(ctx->failure)) return 1;
    Fixture x; reset(&x); write_bytecode(ctx, &x.program, "build/verifier.lbc");
    size_t size;
    unsigned char *original = read_file(ctx, "build/verifier.lbc", &size);
    unsigned char *bytes = malloc(size + 1);
    if (!bytes) return 1;
    check_bytes(original, size, true);
    for (size_t length = 0; length < size; ++length) check_bytes(original, length, false);
    static const struct { size_t offset; uint32_t value; unsigned width; } corruptions[] = {
        {0, 0, 1}, {4, 2, 2}, {6, L_BC_MINOR + 1, 2}, {6, 0, 2}, {8, 0, 4}, {8, L_MAX_FUNCTIONS + 1, 4},
        {12, 2, 4}, {16, 0, 4}, {16, UINT32_MAX, 4}, {20, 0, 1},
        {29, L_MAX_SLOTS + 1, 4}, {33, L_MAX_REGISTERS + 1, 4},
        {37, L_MAX_CODE + 1, 4}, {41, L_MAX_ARGS + 1, 4}, {47, L_MAX_ARRAY + 1, 4}
    };
    for (size_t j = 0; j < sizeof(corruptions) / sizeof(*corruptions); ++j) {
        memcpy(bytes, original, size);
        store(bytes, corruptions[j].offset, corruptions[j].value, corruptions[j].width);
        check_bytes(bytes, size, false);
    }
    /* Slot types occupy bytes 45..46; the two 32-bit lengths start at byte 47. */
    memcpy(bytes, original, size);
    store(bytes, 47, L_MAX_ARRAY, 4); store(bytes, 51, 2, 4);
    check_bytes(bytes, size, false);
    memcpy(bytes, original, size); bytes[size] = 0;
    check_bytes(bytes, size + 1, false);
    free(bytes); cleanup(ctx); free(ctx); remove("build/verifier.lbc"); remove("build/verifier-case.lbc");
    printf("verifier: %d IR cases plus truncation/format mutations passed\n", CASE_COUNT);
    return 0;
}
