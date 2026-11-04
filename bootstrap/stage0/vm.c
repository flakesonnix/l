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
    /* Each slot is a region inside one flat element store; scalar slots occupy one element. */
    uint32_t total = 0;
    uint32_t *offsets = allocate(vm->ctx, f->slot_count * sizeof(*offsets));
    for (uint32_t j = 0; j < f->slot_count; ++j) {
        offsets[j] = total;
        uint32_t width = f->slot_lengths[j] ? f->slot_lengths[j] : 1;
        total += width;
    }
    int32_t *elements = allocate(vm->ctx, total * sizeof(*elements));
    if (f->parameter_count) memcpy(elements, args, f->parameter_count * sizeof(*elements));
    uint32_t pc = 0;
    for (;;) {
        Instruction i = f->code[pc++];
        if (++vm->steps > L_MAX_STEPS) trap(vm, i, "instruction limit exceeded (10000000)");
        int32_t a, b;
        switch (i.op) {
        case OP_CONST:
            /* Define the bit-pattern conversion without implementation-defined unsigned-to-signed casts. */
            registers[i.dst] = i.a <= INT32_MAX ? (int32_t)i.a : (int32_t)((int64_t)i.a - INT64_C(4294967296)); break;
        case OP_LOAD:
            if (!i.c) {
                registers[i.dst] = elements[offsets[i.a]];
            } else {
                /* Defense in depth: the verifier does not force a bounds_check in front of every access. */
                uint32_t index = (uint32_t)registers[i.b];
                if (index >= f->slot_lengths[i.a]) trap(vm, i, "array index out of bounds");
                registers[i.dst] = elements[offsets[i.a] + index];
            }
            break;
        case OP_STORE:
            if (!i.c) {
                elements[offsets[i.dst]] = registers[i.a];
            } else {
                uint32_t index = (uint32_t)registers[i.b];
                if (index >= f->slot_lengths[i.dst]) trap(vm, i, "array index out of bounds");
                elements[offsets[i.dst] + index] = registers[i.a];
            }
            break;
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
            release(vm->ctx, elements); release(vm->ctx, offsets); release(vm->ctx, registers); return value;
        }
        case OP_BOUNDS:
            /* The conversion is the defined mod-2^32 wrap, so negative indexes are caught here. */
            if ((uint32_t)registers[i.a] >= i.c) trap(vm, i, "array index out of bounds");
            break;
        case OP_CLEAR:
            memset(elements + offsets[i.dst], 0, f->slot_lengths[i.dst] * sizeof(*elements));
            break;
        case OP_SWITCH: {
            int32_t value = registers[i.a];
            uint32_t target = i.dst;
            for (uint32_t j = i.b; j < i.b + i.c; ++j) {
                if (f->switch_entries[j].value == value) { target = f->switch_entries[j].target; break; }
            }
            if (target == L_NONE) trap(vm, i, "unhandled switch value");
            pc = target;
            break;
        }
        case OP_TRAP: trap(vm, i, "trap");
        default: trap(vm, i, "invalid opcode");
        }
    }
}

int32_t execute_program(Context *ctx, const Program *p) {
    Vm vm = { ctx, p, 0 };
    Instruction entry = {0};
    return run(&vm, p->entry, NULL, 0, entry);
}
