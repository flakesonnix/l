#include "l.h"

#include <string.h>

typedef struct {
    Context *ctx; const Program *program; uint64_t steps; int32_t *globals;
    uint32_t *global_offsets;
    FILE *input, *output, *error;
} Vm;

static _Noreturn void trap(Vm *vm, Instruction i, const char *message) {
    vm->ctx->status = 70;
    fail(vm->ctx, i.line, i.column, "VM trap: %s", message);
}
/* Flush each write so buffered failures are reported by the operation that caused them. */
static void write_stream(Vm *vm, Instruction i, FILE *file, const void *text, uint32_t length) {
    size_t written = length ? fwrite(text, 1, length, file) : 0;
    if (written != length || ferror(file) || fflush(file) != 0) trap(vm, i, "output write failure");
}
static int32_t checked(Vm *vm, Instruction i, int64_t value) {
    if (value < INT32_MIN || value > INT32_MAX) trap(vm, i, "integer overflow");
    return (int32_t)value;
}
static uint32_t width(const Program *p, Type type) {
    return IS_STRUCT(type) ? p->structs[type - TY_STRUCT].field_count : 1;
}
static void run(Vm *vm, uint32_t index, const int32_t *args, uint32_t depth, Instruction callsite, int32_t *result) {
    if (depth >= L_MAX_DEPTH) trap(vm, callsite, "call depth limit exceeded (256)");
    const IrFunction *f = &vm->program->functions[index];
    const char *saved = vm->ctx->filename;
    if (f->source_path) vm->ctx->filename = f->source_path;
    uint32_t *reg_offsets = allocate(vm->ctx, f->register_count * sizeof(*reg_offsets));
    uint32_t register_cells = 0;
    for (uint32_t j = 0; j < f->register_count; ++j) {
        reg_offsets[j] = register_cells; register_cells += width(vm->program, f->registers[j]);
    }
    int32_t *registers = allocate(vm->ctx, register_cells * sizeof(*registers));
    /* Arrays and structs occupy disjoint regions; copying a value never creates aliases. */
    uint32_t total = 0;
    uint32_t *offsets = allocate(vm->ctx, f->slot_count * sizeof(*offsets));
    for (uint32_t j = 0; j < f->slot_count; ++j) {
        offsets[j] = total;
        total += f->slot_lengths[j] ? f->slot_lengths[j] : width(vm->program, f->slots[j]);
    }
    int32_t *elements = allocate(vm->ctx, total * sizeof(*elements));
    uint32_t argument_cells = 0;
    for (uint32_t j = 0; j < f->parameter_count; ++j) argument_cells += width(vm->program, f->slots[j]);
    if (argument_cells) memcpy(elements, args, argument_cells * sizeof(*elements));
#define R(n) registers[reg_offsets[(n)]]
    uint32_t pc = 0;
    for (;;) {
        Instruction i = f->code[pc++];
        if (++vm->steps > L_MAX_STEPS) trap(vm, i, "instruction limit exceeded (10000000)");
        int32_t a, b;
        switch (i.op) {
        case OP_CONST:
            /* Define the bit-pattern conversion without implementation-defined unsigned-to-signed casts. */
            R(i.dst) = i.a <= INT32_MAX ? (int32_t)i.a : (int32_t)((int64_t)i.a - INT64_C(4294967296)); break;
        case OP_GLOBAL_LOAD: {
            uint32_t offset = vm->global_offsets[i.a];
            if (i.c) {
                uint32_t index = (uint32_t)R(i.b);
                if (index >= vm->program->globals[i.a].length) trap(vm, i, "static array index out of bounds");
                offset += index;
            }
            R(i.dst) = vm->globals[offset]; break;
        }
        case OP_GLOBAL_STORE: {
            uint32_t offset = vm->global_offsets[i.dst];
            if (i.c) {
                uint32_t index = (uint32_t)R(i.b);
                if (index >= vm->program->globals[i.dst].length) trap(vm, i, "static array index out of bounds");
                offset += index;
            }
            vm->globals[offset] = R(i.a); break;
        }
        case OP_STRUCT:
            for (uint32_t j = 0; j < i.b; ++j) registers[reg_offsets[i.dst] + j] = R(f->arguments[i.a + j]);
            break;
        case OP_FIELD: R(i.dst) = registers[reg_offsets[i.a] + i.b]; break;
        case OP_FIELD_STORE: elements[offsets[i.dst] + i.b] = R(i.a); break;
        case OP_TO_BYTE:
            if ((uint32_t)R(i.a) > 255) trap(vm, i, "byte conversion out of range (0..255)");
            R(i.dst) = R(i.a); break;
        case OP_TO_INT: R(i.dst) = R(i.a); break;
        case OP_STRING_LENGTH: R(i.dst) = (int32_t)vm->program->strings[R(i.a)].length; break;
        case OP_STRING_INDEX: {
            IrString string = vm->program->strings[R(i.a)];
            if ((uint32_t)R(i.b) >= string.length) trap(vm, i, "string index out of bounds");
            R(i.dst) = string.bytes[R(i.b)]; break;
        }
        case OP_READ_BYTE: {
            int value = fgetc(vm->input);
            /* A failed stream is a trap; a spent stream yields the documented EOF value. */
            if (ferror(vm->input)) trap(vm, i, "input read failure");
            R(i.dst) = value == EOF ? -1 : value; break;
        }
        case OP_WRITE_BYTE: {
            unsigned char value = (unsigned char)R(i.a); /* Verified byte values are in 0..255. */
            write_stream(vm, i, vm->output, &value, 1); break;
        }
        case OP_WRITE_STRING: case OP_WRITE_ERROR: {
            IrString string = vm->program->strings[R(i.a)];
            write_stream(vm, i, i.op == OP_WRITE_STRING ? vm->output : vm->error,
                string.bytes, string.length); break;
        }
        case OP_LOAD:
            if (!i.c) {
                memcpy(&R(i.dst), elements + offsets[i.a], width(vm->program, f->registers[i.dst]) * sizeof(int32_t));
            } else {
                /* Defense in depth: the verifier does not force a bounds_check in front of every access. */
                uint32_t index = (uint32_t)R(i.b);
                if (index >= f->slot_lengths[i.a]) trap(vm, i, "array index out of bounds");
                R(i.dst) = elements[offsets[i.a] + index];
            }
            break;
        case OP_STORE:
            if (!i.c) {
                memcpy(elements + offsets[i.dst], &R(i.a), width(vm->program, f->slots[i.dst]) * sizeof(int32_t));
            } else {
                uint32_t index = (uint32_t)R(i.b);
                if (index >= f->slot_lengths[i.dst]) trap(vm, i, "array index out of bounds");
                elements[offsets[i.dst] + index] = R(i.a);
            }
            break;
        case OP_ADD: R(i.dst) = checked(vm, i, (int64_t)R(i.a) + R(i.b)); break;
        case OP_SUB: R(i.dst) = checked(vm, i, (int64_t)R(i.a) - R(i.b)); break;
        case OP_MUL: R(i.dst) = checked(vm, i, (int64_t)R(i.a) * R(i.b)); break;
        case OP_DIV: case OP_REM:
            a = R(i.a); b = R(i.b);
            if (!b) trap(vm, i, "division by zero");
            /* int64_t division also avoids host UB for INT32_MIN / -1. */
            if (a == INT32_MIN && b == -1) trap(vm, i, "integer overflow");
            R(i.dst) = checked(vm, i, i.op == OP_DIV ? (int64_t)a / b : (int64_t)a % b); break;
        case OP_NEG: R(i.dst) = checked(vm, i, -(int64_t)R(i.a)); break;
        case OP_NOT: R(i.dst) = !R(i.a); break;
        case OP_EQ: case OP_NE: {
            bool equal = f->registers[i.a] == TY_STRING ?
                string_equal(vm->program->strings[R(i.a)], vm->program->strings[R(i.b)]) : R(i.a) == R(i.b);
            R(i.dst) = i.op == OP_EQ ? equal : !equal; break;
        }
        case OP_LT: R(i.dst) = R(i.a) < R(i.b); break;
        case OP_LE: R(i.dst) = R(i.a) <= R(i.b); break;
        case OP_GT: R(i.dst) = R(i.a) > R(i.b); break;
        case OP_GE: R(i.dst) = R(i.a) >= R(i.b); break;
        case OP_JUMP: pc = i.a; break;
        case OP_BRANCH: pc = R(i.a) ? i.b : i.c; break;
        case OP_CALL: {
            uint32_t cells = 0;
            for (uint32_t j = 0; j < i.c; ++j) cells += width(vm->program, f->registers[f->arguments[i.b + j]]);
            int32_t *arguments = allocate(vm->ctx, cells * sizeof(*arguments));
            uint32_t at = 0;
            for (uint32_t j = 0; j < i.c; ++j) {
                uint32_t source = f->arguments[i.b + j], count = width(vm->program, f->registers[source]);
                memcpy(arguments + at, &R(source), count * sizeof(int32_t)); at += count;
            }
            run(vm, i.a, arguments, depth + 1, i, i.dst == L_NONE ? NULL : &R(i.dst));
            release(vm->ctx, arguments);
            break;
        }
        case OP_RETURN: {
            if (i.a != L_NONE) memcpy(result, &R(i.a), width(vm->program, f->result) * sizeof(int32_t));
            release(vm->ctx, elements); release(vm->ctx, offsets); release(vm->ctx, registers); release(vm->ctx, reg_offsets);
            vm->ctx->filename = saved; return;
        }
        case OP_BOUNDS:
            /* The conversion is the defined mod-2^32 wrap, so negative indexes are caught here. */
            if ((uint32_t)R(i.a) >= i.c) trap(vm, i, "array index out of bounds");
            break;
        case OP_CLEAR:
            memset(elements + offsets[i.dst], 0, f->slot_lengths[i.dst] * sizeof(*elements));
            break;
        case OP_SWITCH: {
            int32_t value = R(i.a);
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
#undef R

int32_t execute_program(Context *ctx, const Program *p) {
    return execute_program_io(ctx, p, stdin, stdout, stderr);
}

int32_t execute_program_io(Context *ctx, const Program *p, FILE *input, FILE *output, FILE *error) {
    Vm vm = {.ctx = ctx, .program = p,
        .global_offsets = allocate(ctx, p->global_count * sizeof(uint32_t)),
        .input = input, .output = output, .error = error};
    uint32_t cells = 0;
    for (uint32_t n = 0; n < p->global_count; ++n) {
        vm.global_offsets[n] = cells; cells += p->globals[n].length ? p->globals[n].length : 1;
    }
    vm.globals = allocate(ctx, cells * sizeof(int32_t));
    for (uint32_t n = 0; n < p->global_count; ++n) vm.globals[vm.global_offsets[n]] = p->globals[n].initial;
    Instruction entry = {0};
    int32_t value;
    run(&vm, p->entry, NULL, 0, entry, &value);
    release(ctx, vm.globals); release(ctx, vm.global_offsets);
    return value;
}
