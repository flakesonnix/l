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
    SwitchEntry entries[L_MAX_CASES];
    IrGlobal globals[L_MAX_GLOBALS];
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
    GLOBAL_STORE_UNDEFINED, GLOBAL_DUPLICATE,
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
        if (execute_program(ctx, p) != 42) exit(1);
    }
    if ((ctx->status == 0) != valid) { fprintf(stderr, "unexpected bytecode result at length %zu\n", size); exit(1); }
    cleanup(ctx); free(ctx);
}
static void store(unsigned char *bytes, size_t offset, uint32_t value, unsigned width) {
    for (unsigned j = 0; j < width; ++j) bytes[offset + j] = (unsigned char)(value >> (8 * j));
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
        {20, 0, 4}, {20, UINT32_MAX, 4}, {24, 0, 1}, {25, TY_AUTO, 1}
    };
    for (size_t n = 0; n < sizeof(corruptions) / sizeof(*corruptions); ++n) {
        memcpy(bytes, original, size); store(bytes, corruptions[n].offset, corruptions[n].value, corruptions[n].width);
        check_bytes(bytes, size, false);
    }
    const uint32_t values[] = {0, 1, 2, UINT32_MAX};
    for (unsigned n = 0; n < 4; ++n) {
        memcpy(bytes, original, size); store(bytes, 25, TY_BOOL, 1); store(bytes, 26, values[n], 4);
        check_bytes(bytes, size, n < 2);
    }
    cleanup(ctx); free(ctx); remove("build/verifier-globals.lbc");
}

int main(void) {
    for (int which = 0; which < CASE_COUNT; ++which) check(which);
    global_bytes();
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
        {0, 0, 1}, {4, 2, 2}, {6, L_BC_MINOR + 1, 2}, {6, 0, 2}, {6, 1, 2}, {6, 2, 2}, {8, 0, 4}, {8, L_MAX_FUNCTIONS + 1, 4},
        {12, 2, 4}, {16, L_MAX_GLOBALS + 1, 4}, {20, 0, 4}, {20, UINT32_MAX, 4}, {24, 0, 1},
        {33, L_MAX_SLOTS + 1, 4}, {37, L_MAX_REGISTERS + 1, 4},
        {41, L_MAX_CODE + 1, 4}, {45, L_MAX_ARGS + 1, 4}, {49, L_MAX_CASES + 1, 4},
        {55, L_MAX_ARRAY + 1, 4}
    };
    for (size_t j = 0; j < sizeof(corruptions) / sizeof(*corruptions); ++j) {
        memcpy(bytes, original, size);
        store(bytes, corruptions[j].offset, corruptions[j].value, corruptions[j].width);
        check_bytes(bytes, size, false);
    }
    /* With no globals, slot types occupy bytes 53..54; lengths start at 55. */
    memcpy(bytes, original, size);
    store(bytes, 55, L_MAX_ARRAY, 4); store(bytes, 59, 2, 4);
    check_bytes(bytes, size, false);
    memcpy(bytes, original, size); bytes[size] = 0;
    check_bytes(bytes, size + 1, false);
    free(bytes); cleanup(ctx); free(ctx); remove("build/verifier.lbc"); remove("build/verifier-case.lbc");
    printf("verifier: %d IR cases plus truncation/format mutations passed\n", CASE_COUNT);
    return 0;
}
