#include "../bootstrap/stage0/l.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    Program program;
    IrFunction functions[2];
    Type slots[2][4], registers[2][8];
    Instruction code[2][12];
    uint32_t arguments[L_MAX_ARGS];
    uint32_t slot_lengths[2][4];
    SwitchEntry entries[L_MAX_CASES];
    IrGlobal globals[L_MAX_GLOBALS];
    IrStruct structs[L_MAX_STRUCTS];
    IrField fields[2][L_MAX_FIELDS];
    char field_names[L_MAX_FIELDS][8];
    IrEnum enums[L_MAX_ENUMS];
    IrMember members[L_MAX_MEMBERS];
    char member_names[L_MAX_MEMBERS][12];
} Fixture;

static Instruction ins(Opcode op, uint32_t dst, uint32_t a, uint32_t b, uint32_t c) {
    return (Instruction){op, dst, a, b, c, 1, 1};
}
static void reset(Fixture *x) {
    memset(x, 0, sizeof(*x));
    x->program = (Program){.function_count = 2, .functions = x->functions, .globals = x->globals};
    for (unsigned j = 0; j < 2; ++j) {
        x->functions[j].name = j ? "helper" : "main";
        x->functions[j].slots = x->slots[j];
        x->functions[j].slot_lengths = x->slot_lengths[j];
        x->functions[j].registers = x->registers[j];
        x->functions[j].code = x->code[j];
        x->functions[j].arguments = x->arguments;
        x->functions[j].switch_entries = x->entries;
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
    SWITCH_VALID, SWITCH_DEFAULT, SWITCH_UNMATCHED_TRAP, SWITCH_SELECTOR_TYPE,
    SWITCH_DUPLICATE, SWITCH_TARGET_RANGE, SWITCH_DEFAULT_RANGE, SWITCH_ENTRY_RANGE,
    SWITCH_CASES_LIMIT, TRAP_DIRECT, SWITCH_UNUSED_TARGET, SWITCH_ENTRY_OFFSET,
    SWITCH_ENTRY_OVERFLOW, SWITCH_UNDEFINED_SELECTOR, SWITCH_MAX_SUCCESSORS,
    SWITCH_LAST_EDGE_UNINITIALIZED, SWITCH_MATCH_NO_DEFAULT, SWITCH_EMPTY_TRAP,
    GLOBAL_LOAD_VALID, GLOBAL_STORE_VALID, GLOBAL_CALL_SHARED, GLOBAL_RESET, GLOBAL_SIGNED, GLOBAL_BOOL, GLOBAL_MAX,
    GLOBAL_LIMIT, GLOBAL_TYPE, GLOBAL_BOOL_HIGH, GLOBAL_BOOL_NEGATIVE, GLOBAL_LOAD_INDEX, GLOBAL_STORE_INDEX,
    GLOBAL_LOAD_REGISTER, GLOBAL_STORE_REGISTER, GLOBAL_LOAD_TYPE, GLOBAL_STORE_TYPE, GLOBAL_BOOL_STORE_TYPE,
    GLOBAL_STORE_UNDEFINED, GLOBAL_DUPLICATE, GLOBAL_STORE_LOCAL_UNINITIALIZED, GLOBAL_STORE_ARRAY_UNINITIALIZED,
    GLOBAL_LOAD_LOCAL_UNINITIALIZED, GLOBAL_STORE_NOT_DOMINATING,
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

/* Valid switch: selector 7 is unmatched by case 42 and falls to default at pc 4. */
static void switch_fixture(Fixture *x) {
    IrFunction *f = &x->functions[0];
    f->register_count = 3;
    x->registers[0][0] = TY_INT; x->registers[0][1] = TY_INT; x->registers[0][2] = TY_INT;
    f->switch_count = 1;
    x->entries[0] = (SwitchEntry){ 42, 3 };
    f->code_count = 6;
    x->code[0][0] = ins(OP_CONST, 0, 7, 0, 0);
    x->code[0][1] = ins(OP_SWITCH, 4, 0, 0, 1);
    x->code[0][2] = ins(OP_TRAP, 0, 0, 0, 0);
    x->code[0][3] = ins(OP_CONST, 1, 42, 0, 0);
    x->code[0][4] = ins(OP_CONST, 2, 42, 0, 0);
    x->code[0][5] = ins(OP_RETURN, 0, 2, 0, 0);
}
static void global_fixture(Fixture *x) {
    x->program.global_count = 1;
    x->globals[0] = (IrGlobal){"g", TY_INT, 42};
    x->code[0][0] = ins(OP_GLOBAL_LOAD, 0, 0, 0, 0);
}
static void struct_fixture(Fixture *x) {
    reset(x);
    x->program.struct_count = 2; x->program.structs = x->structs;
    for (unsigned n = 0; n < 2; ++n) {
        x->structs[n] = (IrStruct){n ? "Q" : "P", 2, x->fields[n]};
        x->fields[n][0] = (IrField){"x", TY_INT}; x->fields[n][1] = (IrField){"b", TY_BOOL};
    }
    IrFunction *f = &x->functions[0];
    x->slots[0][0] = TY_STRUCT;
    f->register_count = 5; f->code_count = 7; f->argument_count = 2;
    x->registers[0][0] = x->registers[0][4] = TY_INT; x->registers[0][1] = TY_BOOL;
    x->registers[0][2] = x->registers[0][3] = TY_STRUCT;
    x->arguments[0] = 0; x->arguments[1] = 1;
    x->code[0][0] = ins(OP_CONST, 0, 42, 0, 0);
    x->code[0][1] = ins(OP_CONST, 1, 1, 0, 0);
    x->code[0][2] = ins(OP_STRUCT, 2, 0, 2, 0);
    x->code[0][3] = ins(OP_STORE, 0, 2, 0, 0);
    x->code[0][4] = ins(OP_LOAD, 3, 0, 0, 0);
    x->code[0][5] = ins(OP_FIELD, 4, 3, 0, 0);
    x->code[0][6] = ins(OP_RETURN, 0, 4, 0, 0);
}
enum {
    S_VALID, S_STORE, S_CALL, S_MAX_STRUCTS, S_MAX_FIELDS,
    S_LIMIT, S_EMPTY, S_FIELDS_LIMIT, S_FIELD_VOID, S_FIELD_STRUCT, S_FIELD_DUPLICATE,
    S_RESULT_TYPE, S_SLOT_TYPE, S_REGISTER_TYPE, S_ARRAY, S_CONSTANT, S_EQUALITY,
    S_MAKE_SCALAR, S_MAKE_ARITY, S_MAKE_OFFSET, S_MAKE_RANGE, S_MAKE_TYPE, S_MAKE_INDEX,
    S_FIELD_SOURCE, S_FIELD_INDEX, S_FIELD_RESULT, S_FIELD_REGISTER,
    S_STORE_SLOT, S_STORE_SCALAR, S_STORE_FIELD, S_STORE_TYPE, S_STORE_REGISTER,
    S_STORE_UNINITIALIZED, S_STORE_UNDEFINED, S_FIELD_UNDEFINED, S_MAKE_UNDEFINED, S_DUPLICATE, S_NOMINAL,
    S_COUNT
};
static void mutate_struct(Fixture *x, int which) {
    IrFunction *f = &x->functions[0], *g = &x->functions[1];
    switch (which) {
    case S_VALID: break;
    case S_STORE:
        f->register_count = 6; x->registers[0][5] = TY_BOOL; f->code_count = 11;
        x->code[0][4] = ins(OP_FIELD_STORE, 0, 1, 1, 0);
        x->code[0][5] = ins(OP_LOAD, 3, 0, 0, 0);
        x->code[0][6] = ins(OP_FIELD, 4, 3, 0, 0);
        x->code[0][7] = ins(OP_FIELD, 5, 3, 1, 0);
        x->code[0][8] = ins(OP_BRANCH, 0, 5, 9, 10);
        x->code[0][9] = ins(OP_RETURN, 0, 4, 0, 0);
        x->code[0][10] = ins(OP_TRAP, 0, 0, 0, 0); break;
    case S_CALL:
        f->argument_count = 3; x->arguments[2] = 2; f->code_count = 10; f->register_count = 7;
        x->registers[0][5] = TY_INT; x->registers[0][6] = TY_BOOL; x->code[0][0].a = 41;
        x->code[0][3] = ins(OP_CALL, 3, 1, 2, 1);
        /* Read the aggregate return and ensure the call cannot alias its argument. */
        x->code[0][4] = ins(OP_FIELD, 4, 3, 0, 0); x->code[0][5] = ins(OP_FIELD, 5, 2, 0, 0);
        x->code[0][6] = ins(OP_EQ, 6, 5, 0, 0); x->code[0][7] = ins(OP_BRANCH, 0, 6, 8, 9);
        x->code[0][8] = ins(OP_RETURN, 0, 4, 0, 0); x->code[0][9] = ins(OP_TRAP, 0, 0, 0, 0);
        g->result = TY_STRUCT; g->parameter_count = g->slot_count = 1; x->slots[1][0] = TY_STRUCT;
        g->register_count = 2; x->registers[1][0] = TY_INT; x->registers[1][1] = TY_STRUCT; g->code_count = 4;
        x->code[1][0] = ins(OP_CONST, 0, 42, 0, 0); x->code[1][1] = ins(OP_FIELD_STORE, 0, 0, 0, 0);
        x->code[1][2] = ins(OP_LOAD, 1, 0, 0, 0); x->code[1][3] = ins(OP_RETURN, 0, 1, 0, 0); break;
    case S_MAX_STRUCTS:
        x->program.struct_count = L_MAX_STRUCTS;
        for (unsigned n = 2; n < L_MAX_STRUCTS; ++n) x->structs[n] = x->structs[0];
        x->slots[0][0] = x->registers[0][2] = x->registers[0][3] = (Type)(TY_STRUCT + L_MAX_STRUCTS - 1); break;
    case S_MAX_FIELDS:
        x->structs[0].field_count = L_MAX_FIELDS; f->argument_count = L_MAX_FIELDS; x->code[0][2].b = L_MAX_FIELDS;
        for (unsigned n = 0; n < L_MAX_FIELDS; ++n) {
            snprintf(x->field_names[n], sizeof(x->field_names[n]), "f%u", n);
            x->fields[0][n] = (IrField){x->field_names[n], n + 1 == L_MAX_FIELDS ? TY_BOOL : TY_INT};
            x->arguments[n] = n + 1 == L_MAX_FIELDS ? 1 : 0;
        }
        x->code[0][5].b = L_MAX_FIELDS - 2; break;
    case S_LIMIT: x->program.struct_count = L_MAX_STRUCTS + 1; break;
    case S_EMPTY: x->structs[0].field_count = 0; break;
    case S_FIELDS_LIMIT: x->structs[0].field_count = L_MAX_FIELDS + 1; break;
    case S_FIELD_VOID: x->fields[0][0].type = TY_VOID; break;
    case S_FIELD_STRUCT: x->fields[0][0].type = TY_STRUCT; break;
    case S_FIELD_DUPLICATE: x->fields[0][1].name = "x"; break;
    case S_RESULT_TYPE: g->result = (Type)(TY_STRUCT + 2); break;
    case S_SLOT_TYPE: x->slots[0][0] = (Type)(TY_STRUCT + 2); break;
    case S_REGISTER_TYPE: x->registers[0][2] = (Type)(TY_STRUCT + 2); break;
    case S_ARRAY: x->slot_lengths[0][0] = 1; break;
    case S_CONSTANT: x->code[0][2] = ins(OP_CONST, 2, 42, 0, 0); break;
    case S_EQUALITY:
        x->registers[0][4] = TY_BOOL; x->code[0][5] = ins(OP_EQ, 4, 2, 3, 0); x->code[0][6].a = 0; break;
    case S_MAKE_SCALAR: x->registers[0][2] = TY_INT; break;
    case S_MAKE_ARITY: x->code[0][2].b = 1; break;
    case S_MAKE_OFFSET: x->code[0][2].a = L_NONE; break;
    case S_MAKE_RANGE: x->code[0][2].a = 1; break;
    case S_MAKE_TYPE: x->arguments[0] = 1; break;
    case S_MAKE_INDEX: x->arguments[0] = L_NONE; break;
    case S_FIELD_SOURCE: x->code[0][5].a = 0; break;
    case S_FIELD_INDEX: x->code[0][5].b = 2; break;
    case S_FIELD_RESULT: x->registers[0][4] = TY_BOOL; x->code[0][6].a = 0; break;
    case S_FIELD_REGISTER: x->code[0][5].a = L_NONE; break;
    case S_STORE_SLOT: case S_STORE_SCALAR: case S_STORE_FIELD: case S_STORE_TYPE: case S_STORE_REGISTER: case S_STORE_UNINITIALIZED:
        x->code[0][3] = ins(OP_FIELD_STORE, which == S_STORE_SLOT ? L_NONE : which == S_STORE_SCALAR ? 1 : 0,
            which == S_STORE_REGISTER ? L_NONE : which == S_STORE_TYPE ? 1 : 0, which == S_STORE_FIELD ? 2 : 0, 0);
        break;
    case S_STORE_UNDEFINED:
        f->code_count = 8; x->code[0][4] = ins(OP_FIELD_STORE, 0, 4, 0, 0);
        x->code[0][5] = ins(OP_LOAD, 3, 0, 0, 0); x->code[0][6] = ins(OP_FIELD, 4, 3, 0, 0);
        x->code[0][7] = ins(OP_RETURN, 0, 4, 0, 0); break;
    case S_FIELD_UNDEFINED:
        x->code[0][2] = ins(OP_FIELD, 4, 2, 0, 0); x->code[0][3] = ins(OP_STRUCT, 2, 0, 2, 0);
        x->code[0][4] = ins(OP_STORE, 0, 2, 0, 0); x->code[0][5] = ins(OP_LOAD, 3, 0, 0, 0); break;
    case S_MAKE_UNDEFINED: x->arguments[0] = 4; break;
    case S_DUPLICATE: x->code[0][3] = x->code[0][2]; break;
    case S_NOMINAL: x->slots[0][0] = (Type)(TY_STRUCT + 1); break;
    }
}
static void check_struct(int which) {
    Context *ctx = calloc(1, sizeof(*ctx)); if (!ctx) exit(1);
    ctx->filename = "struct-verifier-test";
    if (!setjmp(ctx->failure)) {
        Fixture x; struct_fixture(&x); mutate_struct(&x, which);
        verify(ctx, &x.program);
        write_bytecode(ctx, &x.program, "build/verifier-struct.lbc");
        size_t size; unsigned char *bytes = read_file(ctx, "build/verifier-struct.lbc", &size);
        Program *p = read_bytecode(ctx, bytes, size);
        size_t allocated = ctx->allocated;
        for (unsigned repeat = 0; repeat < 3; ++repeat)
            if (execute_program(ctx, p) != 42 || ctx->allocated != allocated) exit(1);
    }
    int expected = which <= S_MAX_FIELDS ? 0 : 65;
    if (ctx->status != expected) { fprintf(stderr, "struct verifier case %d: expected %d, got %d\n", which, expected, ctx->status); exit(1); }
    cleanup(ctx); free(ctx);
}

static void mutate(Fixture *x, int which) {
    IrFunction *f = &x->functions[0], *g = &x->functions[1];
    if (which >= ARRAY_VALID && which < SWITCH_VALID) array_fixture(x);
    if (which >= SWITCH_VALID && which < GLOBAL_LOAD_VALID) switch_fixture(x);
    if (which >= GLOBAL_LOAD_VALID) global_fixture(x);
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
    case SWITCH_VALID: break;
    case SWITCH_DEFAULT: x->code[0][0].a = 42; break;
    case SWITCH_UNMATCHED_TRAP: x->code[0][1].dst = L_NONE; break;
    case SWITCH_MATCH_NO_DEFAULT: x->code[0][0].a = 42; x->code[0][1].dst = L_NONE; break;
    case SWITCH_EMPTY_TRAP:
        f->register_count = 1; f->code_count = 2; f->switch_count = 0;
        x->code[0][1] = ins(OP_SWITCH, L_NONE, 0, 0, 0); break;
    case SWITCH_SELECTOR_TYPE: x->registers[0][0] = TY_BOOL; x->code[0][0].a = 1; break;
    case SWITCH_DUPLICATE:
        f->switch_count = 2; x->entries[1] = (SwitchEntry){ 42, 3 };
        x->code[0][1].c = 2; break;
    case SWITCH_TARGET_RANGE: x->entries[0].target = 99; break;
    case SWITCH_DEFAULT_RANGE: x->code[0][1].dst = 99; break;
    case SWITCH_ENTRY_RANGE: x->code[0][1].b = 1; break;
    case SWITCH_CASES_LIMIT:
        f->switch_count = L_MAX_CASES + 1; x->code[0][1].c = 2; break;
    case TRAP_DIRECT:
        f->register_count = 1; f->code_count = 2; f->switch_count = 0;
        x->code[0][1] = ins(OP_TRAP, 0, 0, 0, 0); break;
    case SWITCH_UNUSED_TARGET:
        f->switch_count = 2; x->entries[1] = (SwitchEntry){ 0, 99 }; break;
    case SWITCH_ENTRY_OFFSET: x->code[0][1].b = UINT32_MAX; break;
    case SWITCH_ENTRY_OVERFLOW: x->code[0][1].c = UINT32_MAX; break;
    case SWITCH_UNDEFINED_SELECTOR: x->code[0][1].a = 1; break;
    case SWITCH_MAX_SUCCESSORS:
        f->switch_count = L_MAX_CASES; x->code[0][1].c = L_MAX_CASES;
        for (uint32_t j = 0; j < L_MAX_CASES; ++j) x->entries[j] = (SwitchEntry){ (int32_t)j, 4 };
        /* Only the final edge reaches r1's definition. Never truncate successors. */
        x->entries[L_MAX_CASES - 1].target = 3; break;
    case SWITCH_LAST_EDGE_UNINITIALIZED:
        f->switch_count = L_MAX_CASES; f->code_count = 7;
        for (uint32_t j = 0; j < L_MAX_CASES; ++j) x->entries[j] = (SwitchEntry){ (int32_t)j, 3 };
        x->entries[L_MAX_CASES - 1].target = 5;
        x->code[0][1] = ins(OP_CONST, 1, 42, 0, 0);
        x->code[0][2] = ins(OP_SWITCH, 3, 0, 0, L_MAX_CASES);
        x->code[0][3] = ins(OP_STORE, 0, 1, 0, 0);
        x->code[0][4] = ins(OP_JUMP, 0, 5, 0, 0);
        x->code[0][5] = ins(OP_LOAD, 2, 0, 0, 0);
        x->code[0][6] = ins(OP_RETURN, 0, 2, 0, 0); break;
    case GLOBAL_LOAD_VALID: break;
    case GLOBAL_STORE_VALID: case GLOBAL_BOOL: case GLOBAL_STORE_TYPE: case GLOBAL_BOOL_STORE_TYPE:
        x->globals[0].initial = 0;
        f->register_count = 2; x->registers[0][1] = TY_INT; f->code_count = 4;
        x->code[0][0] = ins(OP_CONST, 0, 42, 0, 0);
        x->code[0][1] = ins(OP_GLOBAL_STORE, 0, 0, 0, 0);
        x->code[0][2] = ins(OP_GLOBAL_LOAD, 1, 0, 0, 0);
        x->code[0][3] = ins(OP_RETURN, 0, 1, 0, 0);
        if (which == GLOBAL_BOOL) {
            x->globals[0].type = TY_BOOL;
            x->registers[0][0] = x->registers[0][1] = TY_BOOL; x->registers[0][2] = TY_INT;
            f->register_count = 3; f->code_count = 7; x->code[0][0].a = 1;
            x->code[0][3] = ins(OP_BRANCH, 0, 1, 4, 6);
            x->code[0][4] = ins(OP_CONST, 2, 42, 0, 0);
            x->code[0][5] = ins(OP_RETURN, 0, 2, 0, 0);
            x->code[0][6] = ins(OP_TRAP, 0, 0, 0, 0);
        } else if (which == GLOBAL_STORE_TYPE) {
            x->registers[0][0] = TY_BOOL; x->code[0][0].a = 1;
            x->code[0][2] = ins(OP_CONST, 1, 42, 0, 0);
        } else if (which == GLOBAL_BOOL_STORE_TYPE) {
            x->globals[0].type = TY_BOOL; x->code[0][2] = ins(OP_CONST, 1, 42, 0, 0);
        }
        break;
    case GLOBAL_CALL_SHARED:
        x->globals[0].initial = 0; f->code_count = 3;
        x->code[0][0] = ins(OP_CALL, L_NONE, 1, 0, 0);
        x->code[0][1] = ins(OP_GLOBAL_LOAD, 0, 0, 0, 0);
        x->code[0][2] = ins(OP_RETURN, 0, 0, 0, 0);
        g->register_count = 1; x->registers[1][0] = TY_INT; g->code_count = 3;
        x->code[1][0] = ins(OP_CONST, 0, 42, 0, 0);
        x->code[1][1] = ins(OP_GLOBAL_STORE, 0, 0, 0, 0);
        x->code[1][2] = ins(OP_RETURN, 0, L_NONE, 0, 0); break;
    case GLOBAL_RESET:
        x->globals[0].initial = 41; f->register_count = 3; f->code_count = 5;
        x->registers[0][1] = x->registers[0][2] = TY_INT;
        x->code[0][1] = ins(OP_CONST, 1, 1, 0, 0);
        x->code[0][2] = ins(OP_ADD, 2, 0, 1, 0);
        x->code[0][3] = ins(OP_GLOBAL_STORE, 0, 2, 0, 0);
        x->code[0][4] = ins(OP_RETURN, 0, 2, 0, 0); break;
    case GLOBAL_SIGNED:
        x->globals[0].initial = INT32_MIN; f->register_count = 5; f->code_count = 6;
        for (unsigned j = 1; j < 5; ++j) x->registers[0][j] = TY_INT;
        x->code[0][1] = ins(OP_CONST, 1, INT32_MAX, 0, 0);
        x->code[0][2] = ins(OP_ADD, 2, 0, 1, 0);
        x->code[0][3] = ins(OP_CONST, 3, 43, 0, 0);
        x->code[0][4] = ins(OP_ADD, 4, 2, 3, 0);
        x->code[0][5] = ins(OP_RETURN, 0, 4, 0, 0); break;
    case GLOBAL_MAX:
        x->program.global_count = L_MAX_GLOBALS;
        for (unsigned j = 0; j < L_MAX_GLOBALS; ++j) x->globals[j] = (IrGlobal){"g", TY_INT, 42};
        x->code[0][0].a = L_MAX_GLOBALS - 1; break;
    case GLOBAL_LIMIT: x->program.global_count = L_MAX_GLOBALS + 1; break;
    case GLOBAL_TYPE:
        x->globals[0].type = TY_VOID; x->code[0][0] = ins(OP_CONST, 0, 42, 0, 0); break;
    case GLOBAL_BOOL_HIGH: case GLOBAL_BOOL_NEGATIVE:
        x->globals[0].type = TY_BOOL; x->globals[0].initial = which == GLOBAL_BOOL_HIGH ? 2 : -1;
        x->code[0][0] = ins(OP_CONST, 0, 42, 0, 0); break;
    case GLOBAL_LOAD_INDEX: x->code[0][0].a = L_NONE; break;
    case GLOBAL_LOAD_REGISTER: x->code[0][0].dst = 1; break;
    case GLOBAL_STORE_INDEX: case GLOBAL_STORE_REGISTER: case GLOBAL_STORE_UNDEFINED:
        f->code_count = 3;
        x->code[0][0] = ins(OP_CONST, 0, 42, 0, 0);
        x->code[0][1] = ins(OP_GLOBAL_STORE, which == GLOBAL_STORE_INDEX ? L_NONE : 0,
                            which == GLOBAL_STORE_REGISTER ? L_NONE : 0, 0, 0);
        x->code[0][2] = ins(OP_RETURN, 0, 0, 0, 0);
        if (which == GLOBAL_STORE_UNDEFINED) {
            Instruction i = x->code[0][0]; x->code[0][0] = x->code[0][1]; x->code[0][1] = i;
        }
        break;
    case GLOBAL_LOAD_TYPE:
        f->register_count = 2; x->registers[0][0] = TY_BOOL; x->registers[0][1] = TY_INT; f->code_count = 3;
        x->code[0][1] = ins(OP_CONST, 1, 42, 0, 0);
        x->code[0][2] = ins(OP_RETURN, 0, 1, 0, 0); break;
    case GLOBAL_DUPLICATE:
        f->code_count = 3; x->code[0][1] = x->code[0][0];
        x->code[0][2] = ins(OP_RETURN, 0, 0, 0, 0); break;
    case GLOBAL_STORE_LOCAL_UNINITIALIZED: case GLOBAL_LOAD_LOCAL_UNINITIALIZED:
        f->register_count = 2; x->registers[0][1] = TY_INT; f->code_count = 4;
        x->code[0][1] = ins(OP_GLOBAL_STORE, 0, 0, 0, 0);
        if (which == GLOBAL_LOAD_LOCAL_UNINITIALIZED) x->code[0][1] = ins(OP_JUMP, 0, 2, 0, 0);
        x->code[0][2] = ins(OP_LOAD, 1, 0, 0, 0);
        x->code[0][3] = ins(OP_RETURN, 0, 1, 0, 0); break;
    case GLOBAL_STORE_ARRAY_UNINITIALIZED:
        x->slot_lengths[0][0] = 1; f->register_count = 3; f->code_count = 5;
        x->registers[0][1] = x->registers[0][2] = TY_INT;
        x->code[0][1] = ins(OP_CONST, 1, 0, 0, 0);
        x->code[0][2] = ins(OP_GLOBAL_STORE, 0, 0, 0, 0);
        x->code[0][3] = ins(OP_LOAD, 2, 0, 1, 1);
        x->code[0][4] = ins(OP_RETURN, 0, 2, 0, 0); break;
    case GLOBAL_STORE_NOT_DOMINATING:
        f->register_count = 4; f->code_count = 9; x->registers[0][0] = TY_BOOL;
        for (unsigned j = 1; j < 4; ++j) x->registers[0][j] = TY_INT;
        x->code[0][0] = ins(OP_CONST, 0, 1, 0, 0);
        x->code[0][1] = ins(OP_BRANCH, 0, 0, 2, 4);
        x->code[0][2] = ins(OP_CONST, 1, 41, 0, 0);
        x->code[0][3] = ins(OP_JUMP, 0, 6, 0, 0);
        x->code[0][4] = ins(OP_CONST, 2, 43, 0, 0);
        x->code[0][5] = ins(OP_JUMP, 0, 6, 0, 0);
        x->code[0][6] = ins(OP_GLOBAL_STORE, 0, 1, 0, 0);
        x->code[0][7] = ins(OP_CONST, 3, 42, 0, 0);
        x->code[0][8] = ins(OP_RETURN, 0, 3, 0, 0); break;
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
        size_t allocated = ctx->allocated;
        int32_t result = execute_program(ctx, program);
        if (result != 42) exit(1);
        if (which == GLOBAL_RESET && (execute_program(ctx, program) != 42 || ctx->allocated != allocated)) exit(1);
    }
    int expected = which == VALID || which == DIAMOND || which == LOAD_STORE ||
        which == ARRAY_VALID || which == ARRAY_NOCHECK ||
        which == SWITCH_VALID || which == SWITCH_DEFAULT || which == SWITCH_MAX_SUCCESSORS ||
        which == SWITCH_MATCH_NO_DEFAULT || (which >= GLOBAL_LOAD_VALID && which <= GLOBAL_MAX) ? 0 : 65;
    if (which == VM_BAD_OPCODE || (which >= ARRAY_VM_LOAD_OOB && which < SWITCH_VALID)) expected = 70;
    if (which == SWITCH_UNMATCHED_TRAP || which == TRAP_DIRECT || which == SWITCH_EMPTY_TRAP) expected = 70;
    if (ctx->status != expected) { fprintf(stderr, "verifier case %d: expected %d, got %d\n", which, expected, ctx->status); exit(1); }
    cleanup(ctx); free(ctx);
}

static void check_bytes(const unsigned char *bytes, size_t size, bool valid) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) exit(1);
    ctx->filename = "bytecode-test";
    if (!setjmp(ctx->failure)) {
        Program *p = read_bytecode(ctx, bytes, size);
        if (valid && execute_program(ctx, p) != 42) exit(1);
    }
    if ((ctx->status == 0) != valid) { fprintf(stderr, "unexpected bytecode result at length %zu\n", size); exit(1); }
    cleanup(ctx); free(ctx);
}
static void store(unsigned char *bytes, size_t offset, uint32_t value, unsigned width) {
    for (unsigned j = 0; j < width; ++j) bytes[offset + j] = (unsigned char)(value >> (8 * j));
}
static void enum_fixture(Fixture *x) {
    reset(x);
    x->program.enum_count = 2; x->program.enums = x->enums;
    x->enums[0] = (IrEnum){"E", 5, x->members}; x->enums[1] = (IrEnum){"F", 5, x->members};
    x->members[0] = (IrMember){"A", -7}; x->members[1] = (IrMember){"B", 0};
    x->members[2] = (IrMember){"C", INT32_MIN}; x->members[3] = (IrMember){"D", INT32_MAX};
    x->members[4] = (IrMember){"Alias", -7};
    x->program.struct_count = 1; x->program.structs = x->structs;
    x->structs[0] = (IrStruct){"P", 1, x->fields[0]}; x->fields[0][0] = (IrField){"kind", TY_ENUM};
    x->program.global_count = 1; x->globals[0] = (IrGlobal){"g", TY_ENUM, -7};
    IrFunction *f = &x->functions[0];
    f->slot_count = 1; x->slots[0][0] = TY_ENUM;
    f->register_count = 4; x->registers[0][0] = x->registers[0][1] = TY_ENUM;
    x->registers[0][2] = TY_BOOL; x->registers[0][3] = TY_INT;
    f->code_count = 8;
    x->code[0][0] = ins(OP_GLOBAL_LOAD, 0, 0, 0, 0);
    x->code[0][1] = ins(OP_STORE, 0, 0, 0, 0);
    x->code[0][2] = ins(OP_CONST, 1, (uint32_t)-7, 0, 0);
    x->code[0][3] = ins(OP_EQ, 2, 0, 1, 0);
    x->code[0][4] = ins(OP_BRANCH, 0, 2, 5, 7);
    x->code[0][5] = ins(OP_CONST, 3, 42, 0, 0);
    x->code[0][6] = ins(OP_RETURN, 0, 3, 0, 0);
    x->code[0][7] = ins(OP_TRAP, 0, 0, 0, 0);
}
enum {
    E_VALID, E_SWITCH, E_CALL, E_MIN, E_MAX, E_ZERO, E_MAX_ENUMS, E_MAX_MEMBERS,
    E_LIMIT, E_EMPTY, E_MEMBERS_LIMIT, E_MEMBER_DUPLICATE,
    E_RESULT_ID, E_SLOT_ID, E_REGISTER_ID, E_GLOBAL_ID, E_FIELD_ID,
    E_CONSTANT_VALUE, E_GLOBAL_VALUE, E_ARRAY, E_EQUALITY, E_STORE, E_GLOBAL_LOAD,
    E_ARITHMETIC, E_NEGATE, E_ORDER, E_BRANCH, E_MAKE, E_FIELD, E_FIELD_STORE,
    E_SWITCH_VALUE, E_SWITCH_DUPLICATE, E_SWITCH_BOOL, E_COUNT
};
static void mutate_enum(Fixture *x, int which) {
    IrFunction *f = &x->functions[0], *g = &x->functions[1];
    if (which == E_SWITCH || which >= E_SWITCH_VALUE) {
        f->switch_count = 4;
        for (unsigned n = 0; n < 4; ++n) x->entries[n] = (SwitchEntry){x->members[n].value, n ? 7 : 5};
        x->code[0][4] = ins(OP_SWITCH, 7, 0, 0, 4);
    }
    switch (which) {
    case E_VALID: case E_SWITCH: break;
    case E_CALL:
        f->argument_count = 1; x->arguments[0] = 0; x->code[0][2] = ins(OP_CALL, 1, 1, 0, 1);
        g->parameter_count = g->slot_count = g->register_count = 1; g->result = TY_ENUM;
        x->slots[1][0] = x->registers[1][0] = TY_ENUM; g->code_count = 2;
        x->code[1][0] = ins(OP_LOAD, 0, 0, 0, 0); x->code[1][1] = ins(OP_RETURN, 0, 0, 0, 0); break;
    case E_MIN: case E_MAX: case E_ZERO:
        x->globals[0].initial = which == E_MIN ? INT32_MIN : which == E_MAX ? INT32_MAX : 0;
        x->code[0][2].a = (uint32_t)x->globals[0].initial; break;
    case E_MAX_ENUMS:
        x->program.enum_count = L_MAX_ENUMS;
        for (unsigned n = 2; n < L_MAX_ENUMS; ++n) x->enums[n] = x->enums[0];
        x->globals[0].type = x->fields[0][0].type = x->slots[0][0] = x->registers[0][0] = x->registers[0][1] = (Type)(TY_ENUM + L_MAX_ENUMS - 1); break;
    case E_MAX_MEMBERS:
        x->enums[0].member_count = L_MAX_MEMBERS;
        for (unsigned n = 0; n < L_MAX_MEMBERS; ++n) {
            snprintf(x->member_names[n], sizeof(x->member_names[n]), "M%u", n);
            x->members[n] = (IrMember){x->member_names[n], n + 1 == L_MAX_MEMBERS ? -7 : (int32_t)n};
        }
        break;
    case E_LIMIT: x->program.enum_count = L_MAX_ENUMS + 1; break;
    case E_EMPTY: x->enums[0].member_count = 0; break;
    case E_MEMBERS_LIMIT: x->enums[0].member_count = L_MAX_MEMBERS + 1; break;
    case E_MEMBER_DUPLICATE: x->members[1].name = "A"; break;
    case E_RESULT_ID: g->result = (Type)(TY_ENUM + 2); break;
    case E_SLOT_ID: x->slots[0][0] = (Type)(TY_ENUM + 2); break;
    case E_REGISTER_ID: x->registers[0][0] = (Type)(TY_ENUM + 2); break;
    case E_GLOBAL_ID: x->globals[0].type = (Type)(TY_ENUM + 2); break;
    case E_FIELD_ID: x->fields[0][0].type = (Type)(TY_ENUM + 2); break;
    case E_CONSTANT_VALUE: x->code[0][2].a = 1; break;
    case E_GLOBAL_VALUE: x->globals[0].initial = 1; break;
    case E_ARRAY: x->slot_lengths[0][0] = 1; break;
    case E_EQUALITY: x->registers[0][1] = (Type)(TY_ENUM + 1); break;
    case E_STORE: x->slots[0][0] = (Type)(TY_ENUM + 1); break;
    case E_GLOBAL_LOAD: x->globals[0].type = (Type)(TY_ENUM + 1); break;
    case E_ARITHMETIC: x->code[0][3] = ins(OP_ADD, 3, 0, 1, 0); break;
    case E_NEGATE: x->code[0][3] = ins(OP_NEG, 3, 0, 0, 0); break;
    case E_ORDER: x->code[0][3] = ins(OP_LT, 2, 0, 1, 0); break;
    case E_BRANCH: x->code[0][4].a = 0; break;
    case E_MAKE: x->code[0][2] = ins(OP_STRUCT, 1, 0, 1, 0); break;
    case E_FIELD: x->code[0][3] = ins(OP_FIELD, 2, 0, 0, 0); break;
    case E_FIELD_STORE: x->code[0][3] = ins(OP_FIELD_STORE, 0, 0, 0, 0); break;
    case E_SWITCH_VALUE: x->entries[1].value = 1; break;
    case E_SWITCH_DUPLICATE: x->entries[1].value = -7; break;
    case E_SWITCH_BOOL: x->code[0][4].a = 2; break;
    }
}
static void check_enum(int which) {
    Context *ctx = calloc(1, sizeof(*ctx)); if (!ctx) exit(1);
    ctx->filename = "enum-verifier-test";
    if (!setjmp(ctx->failure)) {
        Fixture x; enum_fixture(&x); mutate_enum(&x, which);
        verify(ctx, &x.program);
        write_bytecode(ctx, &x.program, "build/verifier-enum.lbc");
        size_t size; unsigned char *bytes = read_file(ctx, "build/verifier-enum.lbc", &size);
        Program *p = read_bytecode(ctx, bytes, size);
        size_t allocated = ctx->allocated;
        for (unsigned repeat = 0; repeat < 3; ++repeat)
            if (execute_program(ctx, p) != 42 || ctx->allocated != allocated || p->globals[0].initial != x.globals[0].initial) exit(1);
    }
    int expected = which <= E_MAX_MEMBERS ? 0 : 65;
    if (ctx->status != expected) { fprintf(stderr, "enum verifier case %d: expected %d, got %d\n", which, expected, ctx->status); exit(1); }
    cleanup(ctx); free(ctx);
}
static void enum_bytes(void) {
    Context *ctx = calloc(1, sizeof(*ctx)); if (!ctx) exit(1);
    ctx->filename = "enum-format-test"; if (setjmp(ctx->failure)) exit(1);
    Fixture x; enum_fixture(&x); x.program.struct_count = 0; x.program.enum_count = 1; x.enums[0].member_count = 2;
    write_bytecode(ctx, &x.program, "build/verifier-enum.lbc");
    size_t size; unsigned char *original = read_file(ctx, "build/verifier-enum.lbc", &size), *bytes = allocate(ctx, size);
    check_bytes(original, size, true);
    for (size_t n = 0; n < size; ++n) check_bytes(original, n, false);
    static const struct { size_t offset; uint32_t value; unsigned width; } corruptions[] = {
        {24, L_MAX_ENUMS + 1, 4}, {28, 0, 4}, {28, UINT32_MAX, 4}, {32, 0, 1},
        {33, 0, 4}, {33, L_MAX_MEMBERS + 1, 4}, {37, 0, 4}, {37, UINT32_MAX, 4}, {41, 0, 1},
        {50, 'A', 1}, {60, TY_ENUM + 1, 4}, {64, 1, 4}, {42, 1, 4}
    };
    for (size_t n = 0; n < sizeof(corruptions) / sizeof(*corruptions); ++n) {
        memcpy(bytes, original, size); store(bytes, corruptions[n].offset, corruptions[n].value, corruptions[n].width);
        check_bytes(bytes, size, false);
    }
    cleanup(ctx); free(ctx); remove("build/verifier-enum.lbc");
}
static void byte_fixture(Fixture *x) {
    reset(x);
    x->program.global_count = 1; x->globals[0] = (IrGlobal){"b", TY_BYTE, 42};
    x->program.struct_count = 1; x->program.structs = x->structs;
    x->structs[0] = (IrStruct){"P", 1, x->fields[0]}; x->fields[0][0] = (IrField){"b", TY_BYTE};
    IrFunction *f = &x->functions[0];
    f->slot_count = 2; x->slots[0][0] = x->slots[0][1] = TY_BYTE; x->slot_lengths[0][1] = 2;
    f->register_count = 5;
    x->registers[0][0] = x->registers[0][3] = x->registers[0][4] = TY_INT;
    x->registers[0][1] = x->registers[0][2] = TY_BYTE;
    f->code_count = 10;
    x->code[0][0] = ins(OP_CONST, 0, 42, 0, 0);
    x->code[0][1] = ins(OP_TO_BYTE, 1, 0, 0, 0);
    x->code[0][2] = ins(OP_STORE, 0, 1, 0, 0);
    x->code[0][3] = ins(OP_CLEAR, 1, 0, 0, 0);
    x->code[0][4] = ins(OP_CONST, 4, 0, 0, 0);
    x->code[0][5] = ins(OP_STORE, 1, 1, 4, 1);
    x->code[0][6] = ins(OP_LOAD, 2, 1, 4, 1);
    x->code[0][7] = ins(OP_GLOBAL_STORE, 0, 2, 0, 0);
    x->code[0][8] = ins(OP_TO_INT, 3, 2, 0, 0);
    x->code[0][9] = ins(OP_RETURN, 0, 3, 0, 0);
}
enum {
    B_VALID, B_ZERO, B_MAX, B_CONSTANT, B_GLOBAL, B_CALL, B_SCALAR, B_FIELD, B_SWITCH,
    B_NARROW_HIGH_TRAP, B_NARROW_NEGATIVE_TRAP, B_LOAD_BOUNDS_TRAP, B_STORE_BOUNDS_TRAP,
    B_CONST_HIGH, B_CONST_NEGATIVE, B_GLOBAL_HIGH, B_GLOBAL_NEGATIVE,
    B_NARROW_SOURCE, B_NARROW_DEST, B_WIDEN_SOURCE, B_WIDEN_DEST, B_SOURCE_INDEX, B_DEST_INDEX,
    B_NARROW_UNDEFINED, B_WIDEN_UNDEFINED, B_DUPLICATE, B_ARRAY_UNINITIALIZED,
    B_ARRAY_TYPE, B_GLOBAL_TYPE, B_SWITCH_HIGH, B_SWITCH_NEGATIVE, B_SWITCH_DUPLICATE,
    B_FIELD_TYPE, B_CALL_TYPE, B_RETURN_TYPE, B_COUNT
};
static void mutate_byte(Fixture *x, int which) {
    IrFunction *f = &x->functions[0], *g = &x->functions[1];
    if (which == B_CALL || which == B_CALL_TYPE || which == B_RETURN_TYPE) {
        f->argument_count = 1; x->arguments[0] = 1; x->code[0][6] = ins(OP_CALL, 2, 1, 0, 1);
        g->result = TY_BYTE; g->parameter_count = g->slot_count = g->register_count = 1; g->code_count = 2;
        x->slots[1][0] = x->registers[1][0] = TY_BYTE;
        x->code[1][0] = ins(OP_LOAD, 0, 0, 0, 0); x->code[1][1] = ins(OP_RETURN, 0, 0, 0, 0);
    }
    if (which == B_FIELD || which == B_FIELD_TYPE) {
        f->register_count = 6; x->registers[0][5] = TY_STRUCT; f->argument_count = 1; x->arguments[0] = 1;
        x->code[0][5] = ins(OP_STRUCT, 5, 0, 1, 0); x->code[0][6] = ins(OP_FIELD, 2, 5, 0, 0);
    }
    if (which == B_SWITCH || (which >= B_SWITCH_HIGH && which <= B_SWITCH_DUPLICATE)) {
        f->switch_count = 2; x->entries[0] = (SwitchEntry){0, 11}; x->entries[1] = (SwitchEntry){42, 10};
        f->code_count = 12; x->code[0][9] = ins(OP_SWITCH, 11, 2, 0, 2);
        x->code[0][10] = ins(OP_RETURN, 0, 3, 0, 0); x->code[0][11] = ins(OP_TRAP, 0, 0, 0, 0);
    }
    switch (which) {
    case B_VALID: case B_CALL: case B_FIELD: case B_SWITCH: break;
    case B_ZERO: case B_MAX:
        x->code[0][0].a = which == B_ZERO ? 0 : 255; x->globals[0].initial = (int32_t)x->code[0][0].a; break;
    case B_CONSTANT: x->code[0][1] = ins(OP_CONST, 1, 42, 0, 0); break;
    case B_GLOBAL: x->code[0][1] = ins(OP_GLOBAL_LOAD, 1, 0, 0, 0); break;
    case B_SCALAR: x->code[0][6] = ins(OP_LOAD, 2, 0, 0, 0); break;
    case B_NARROW_HIGH_TRAP: x->code[0][0].a = 256; break;
    case B_NARROW_NEGATIVE_TRAP: x->code[0][0].a = UINT32_MAX; break;
    case B_LOAD_BOUNDS_TRAP: x->code[0][6].b = 0; break;
    case B_STORE_BOUNDS_TRAP: x->code[0][5].b = 0; break;
    case B_CONST_HIGH: case B_CONST_NEGATIVE:
        x->code[0][1] = ins(OP_CONST, 1, which == B_CONST_HIGH ? 256 : UINT32_MAX, 0, 0); break;
    case B_GLOBAL_HIGH: case B_GLOBAL_NEGATIVE: x->globals[0].initial = which == B_GLOBAL_HIGH ? 256 : -1; break;
    case B_NARROW_SOURCE: x->code[0][1].a = 2; break;
    case B_NARROW_DEST: x->registers[0][1] = TY_INT; break;
    case B_WIDEN_SOURCE: x->code[0][8].a = 0; break;
    case B_WIDEN_DEST: x->registers[0][3] = TY_BYTE; break;
    case B_SOURCE_INDEX: x->code[0][1].a = L_NONE; break;
    case B_DEST_INDEX: x->code[0][8].dst = L_NONE; break;
    case B_NARROW_UNDEFINED: x->code[0][1].a = 3; break;
    case B_WIDEN_UNDEFINED:
        x->code[0][0] = ins(OP_TO_INT, 0, 2, 0, 0); break;
    case B_DUPLICATE: x->code[0][8] = ins(OP_TO_BYTE, 1, 0, 0, 0); break;
    case B_ARRAY_UNINITIALIZED: x->code[0][3] = ins(OP_JUMP, 0, 4, 0, 0); break;
    case B_ARRAY_TYPE: x->slots[0][1] = TY_INT; break;
    case B_GLOBAL_TYPE: x->code[0][7].a = 0; break;
    case B_SWITCH_HIGH: case B_SWITCH_NEGATIVE: x->entries[0].value = which == B_SWITCH_HIGH ? 256 : -1; break;
    case B_SWITCH_DUPLICATE: x->entries[0].value = 42; break;
    case B_FIELD_TYPE: x->fields[0][0].type = TY_INT; break;
    case B_CALL_TYPE: x->arguments[0] = 0; break;
    case B_RETURN_TYPE: g->result = TY_INT; x->registers[0][2] = TY_INT; x->code[0][7].a = 1; x->code[0][8].a = 1; break;
    }
}
static void check_byte(int which, bool serialized) {
    Context *ctx = calloc(1, sizeof(*ctx)); if (!ctx) exit(1);
    ctx->filename = "byte-verifier-test";
    if (!setjmp(ctx->failure)) {
        Fixture x; byte_fixture(&x); mutate_byte(&x, which);
        Program *p = &x.program;
        if (serialized) {
            write_bytecode(ctx, p, "build/verifier-byte.lbc");
            size_t size; unsigned char *bytes = read_file(ctx, "build/verifier-byte.lbc", &size);
            p = read_bytecode(ctx, bytes, size);
        } else verify(ctx, p);
        if (which > B_STORE_BOUNDS_TRAP) { fprintf(stderr, "byte verifier accepted invalid case %d\n", which); exit(1); }
        size_t allocated = ctx->allocated;
        int32_t value = which == B_ZERO ? 0 : which == B_MAX ? 255 : 42, initial = p->globals[0].initial;
        for (unsigned repeat = 0; repeat < 3; ++repeat)
            if (execute_program(ctx, p) != value || ctx->allocated != allocated || p->globals[0].initial != initial) exit(1);
    }
    int expected = which <= B_SWITCH ? 0 : which <= B_STORE_BOUNDS_TRAP ? 70 : 65;
    if (ctx->status != expected) { fprintf(stderr, "byte verifier case %d: expected %d, got %d\n", which, expected, ctx->status); exit(1); }
    cleanup(ctx); free(ctx);
}
static void global_bytes(void) {
    Context *ctx = calloc(1, sizeof(*ctx)); if (!ctx) exit(1);
    ctx->filename = "global-format-test"; if (setjmp(ctx->failure)) exit(1);
    Fixture x; reset(&x); global_fixture(&x);
    x.code[0][0] = ins(OP_CONST, 0, 42, 0, 0); /* Validate unused global metadata too. */
    write_bytecode(ctx, &x.program, "build/verifier-globals.lbc");
    size_t size; unsigned char *original = read_file(ctx, "build/verifier-globals.lbc", &size);
    unsigned char *bytes = allocate(ctx, size);
    check_bytes(original, size, true);
    for (size_t n = 0; n < size; ++n) check_bytes(original, n, false);
    static const struct { size_t offset; uint32_t value; unsigned width; } corruptions[] = {
        {28, 0, 4}, {28, UINT32_MAX, 4}, {32, 0, 1}, {33, TY_AUTO, 4}
    };
    for (size_t n = 0; n < sizeof(corruptions) / sizeof(*corruptions); ++n) {
        memcpy(bytes, original, size); store(bytes, corruptions[n].offset, corruptions[n].value, corruptions[n].width);
        check_bytes(bytes, size, false);
    }
    const uint32_t values[] = {0, 1, 2, UINT32_MAX};
    for (unsigned n = 0; n < 4; ++n) {
        memcpy(bytes, original, size); store(bytes, 33, TY_BOOL, 4); store(bytes, 37, values[n], 4);
        check_bytes(bytes, size, n < 2);
    }
    cleanup(ctx); free(ctx); remove("build/verifier-globals.lbc");
}
static void struct_bytes(void) {
    Context *ctx = calloc(1, sizeof(*ctx)); if (!ctx) exit(1);
    ctx->filename = "struct-format-test"; if (setjmp(ctx->failure)) exit(1);
    Fixture x; struct_fixture(&x); x.program.struct_count = 1;
    write_bytecode(ctx, &x.program, "build/verifier-struct.lbc");
    size_t size; unsigned char *original = read_file(ctx, "build/verifier-struct.lbc", &size), *bytes = allocate(ctx, size);
    check_bytes(original, size, true);
    for (size_t n = 0; n < size; ++n) check_bytes(original, n, false);
    static const struct { size_t offset; uint32_t value; unsigned width; } corruptions[] = {
        {28, 0, 4}, {28, UINT32_MAX, 4}, {32, 0, 1}, {33, 0, 4}, {33, L_MAX_FIELDS + 1, 4},
        {37, 0, 4}, {37, UINT32_MAX, 4}, {41, 0, 1}, {42, TY_VOID, 4}, {42, TY_STRUCT, 4}, {42, UINT32_MAX, 4},
        {50, 'x', 1}, {51, TY_AUTO, 4}
    };
    for (size_t n = 0; n < sizeof(corruptions) / sizeof(*corruptions); ++n) {
        memcpy(bytes, original, size); store(bytes, corruptions[n].offset, corruptions[n].value, corruptions[n].width);
        check_bytes(bytes, size, false);
    }
    cleanup(ctx); free(ctx); remove("build/verifier-struct.lbc");
}

int main(void) {
    for (int which = 0; which < CASE_COUNT; ++which) check(which);
    for (int which = 0; which < S_COUNT; ++which) check_struct(which);
    for (int which = 0; which < E_COUNT; ++which) check_enum(which);
    for (int which = 0; which < B_COUNT; ++which) { check_byte(which, false); check_byte(which, true); }
    remove("build/verifier-byte.lbc");
    global_bytes();
    struct_bytes();
    enum_bytes();
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
        {0, 0, 1}, {4, 2, 2}, {6, L_BC_MINOR + 1, 2}, {6, 0, 2}, {6, 1, 2}, {6, 2, 2}, {6, 3, 2}, {6, 4, 2}, {6, 5, 2}, {8, 0, 4}, {8, L_MAX_FUNCTIONS + 1, 4},
        {12, 2, 4}, {16, L_MAX_GLOBALS + 1, 4}, {20, L_MAX_STRUCTS + 1, 4}, {24, L_MAX_ENUMS + 1, 4}, {28, 0, 4}, {28, UINT32_MAX, 4}, {32, 0, 1},
        {44, L_MAX_SLOTS + 1, 4}, {48, L_MAX_REGISTERS + 1, 4},
        {52, L_MAX_CODE + 1, 4}, {56, L_MAX_ARGS + 1, 4}, {60, L_MAX_CASES + 1, 4},
        {72, L_MAX_ARRAY + 1, 4}
    };
    for (size_t j = 0; j < sizeof(corruptions) / sizeof(*corruptions); ++j) {
        memcpy(bytes, original, size);
        store(bytes, corruptions[j].offset, corruptions[j].value, corruptions[j].width);
        check_bytes(bytes, size, false);
    }
    /* With empty nominal/global tables, slot types start at 64; lengths start at 72. */
    memcpy(bytes, original, size);
    store(bytes, 72, L_MAX_ARRAY, 4); store(bytes, 76, 2, 4);
    check_bytes(bytes, size, false);
    memcpy(bytes, original, size); bytes[size] = 0;
    check_bytes(bytes, size + 1, false);
    free(bytes); cleanup(ctx); free(ctx); remove("build/verifier.lbc"); remove("build/verifier-case.lbc");
    printf("verifier: %d IR cases plus truncation/format mutations passed\n", CASE_COUNT + S_COUNT + E_COUNT + B_COUNT);
    return 0;
}
