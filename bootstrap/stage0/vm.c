#include "l.h"

#include <string.h>

typedef struct { Context *ctx; const Program *program; uint64_t steps; } Vm;

static _Noreturn void trap(Vm *vm, Instruction i, const char *message) {
    vm->ctx->status = 70;
    fail(vm->ctx, i.line, i.column, "VM trap: %s", message);
}
static int32_t checked(Vm *vm, Instruction i, int64_t value) {
    if (value < INT32_MIN || value > INT32_MAX) trap(vm, i, "integer overflow");
    return (int32_t)value;
}
static int32_t run(Vm *vm, uint32_t index, const int32_t *args, uint32_t depth, Instruction callsite) {
    if (depth >= L_MAX_DEPTH) trap(vm, callsite, "call depth limit exceeded (256)");
    const IrFunction *f = &vm->program->functions[index];
    int32_t *registers = allocate(vm->ctx, f->register_count * sizeof(*registers));
    int32_t *slots = allocate(vm->ctx, f->slot_count * sizeof(*slots));
    if (f->parameter_count) memcpy(slots, args, f->parameter_count * sizeof(*slots));
    uint32_t pc = 0;
    for (;;) {
        Instruction i = f->code[pc++];
        if (++vm->steps > L_MAX_STEPS) trap(vm, i, "instruction limit exceeded (10000000)");
        int32_t a, b;
        switch (i.op) {
        case OP_CONST:
            /* Define the bit-pattern conversion without implementation-defined unsigned-to-signed casts. */
            registers[i.dst] = i.a <= INT32_MAX ? (int32_t)i.a : (int32_t)((int64_t)i.a - INT64_C(4294967296)); break;
        case OP_LOAD: registers[i.dst] = slots[i.a]; break;
        case OP_STORE: slots[i.dst] = registers[i.a]; break;
        case OP_ADD: registers[i.dst] = checked(vm, i, (int64_t)registers[i.a] + registers[i.b]); break;
        case OP_SUB: registers[i.dst] = checked(vm, i, (int64_t)registers[i.a] - registers[i.b]); break;
        case OP_MUL: registers[i.dst] = checked(vm, i, (int64_t)registers[i.a] * registers[i.b]); break;
        case OP_DIV: case OP_REM:
            a = registers[i.a]; b = registers[i.b];
            if (!b) trap(vm, i, "division by zero");
            /* int64_t division also avoids host UB for INT32_MIN / -1. */
            if (a == INT32_MIN && b == -1) trap(vm, i, "integer overflow");
            registers[i.dst] = checked(vm, i, i.op == OP_DIV ? (int64_t)a / b : (int64_t)a % b); break;
        case OP_NEG: registers[i.dst] = checked(vm, i, -(int64_t)registers[i.a]); break;
        case OP_NOT: registers[i.dst] = !registers[i.a]; break;
        case OP_EQ: registers[i.dst] = registers[i.a] == registers[i.b]; break;
        case OP_NE: registers[i.dst] = registers[i.a] != registers[i.b]; break;
        case OP_LT: registers[i.dst] = registers[i.a] < registers[i.b]; break;
        case OP_LE: registers[i.dst] = registers[i.a] <= registers[i.b]; break;
        case OP_GT: registers[i.dst] = registers[i.a] > registers[i.b]; break;
        case OP_GE: registers[i.dst] = registers[i.a] >= registers[i.b]; break;
        case OP_JUMP: pc = i.a; break;
        case OP_BRANCH: pc = registers[i.a] ? i.b : i.c; break;
        case OP_CALL: {
            int32_t arguments[L_MAX_SLOTS];
            for (uint32_t j = 0; j < i.c; ++j) arguments[j] = registers[f->arguments[i.b + j]];
            int32_t value = run(vm, i.a, arguments, depth + 1, i);
            if (i.dst != L_NONE) registers[i.dst] = value;
            break;
        }
        case OP_RETURN: {
            int32_t value = i.a == L_NONE ? 0 : registers[i.a];
            release(vm->ctx, slots); release(vm->ctx, registers); return value;
        }
        default: trap(vm, i, "invalid opcode");
        }
    }
}

int32_t execute_program(Context *ctx, const Program *p) {
    Vm vm = { ctx, p, 0 };
    Instruction entry = {0};
    return run(&vm, p->entry, NULL, 0, entry);
}
