#include "l.h"

#include <string.h>

typedef struct { Context *ctx; const unsigned char *data; size_t size, at; } Reader;
static uint32_t get(Reader *r, unsigned width) {
    if (width > r->size - r->at) fail(r->ctx, 0, 0, "truncated bytecode");
    uint32_t value = 0;
    for (unsigned j = 0; j < width; ++j) value |= (uint32_t)r->data[r->at++] << (8 * j);
    return value;
}
static void put(FILE *file, uint32_t value, unsigned width) {
    for (unsigned j = 0; j < width; ++j) fputc((int)((value >> (8 * j)) & 255), file);
}

void write_bytecode(Context *ctx, const Program *p, const char *path) {
    FILE *file = fopen(path, "wb");
    if (!file) { ctx->status = 74; fail(ctx, 0, 0, "cannot open bytecode output"); }
    fwrite("LBC\0", 1, 4, file);
    put(file, L_BC_MAJOR, 2); put(file, L_BC_MINOR, 2);
    put(file, p->function_count, 4); put(file, p->entry, 4);
    for (uint32_t n = 0; n < p->function_count; ++n) {
        const IrFunction *f = &p->functions[n];
        uint32_t length = (uint32_t)strlen(f->name);
        put(file, length, 4); fwrite(f->name, 1, length, file);
        put(file, f->result, 1); put(file, f->parameter_count, 4); put(file, f->slot_count, 4);
        put(file, f->register_count, 4); put(file, f->code_count, 4); put(file, f->argument_count, 4);
        put(file, f->switch_count, 4);
        for (uint32_t j = 0; j < f->slot_count; ++j) put(file, f->slots[j], 1);
        for (uint32_t j = 0; j < f->slot_count; ++j) put(file, f->slot_lengths[j], 4);
        for (uint32_t j = 0; j < f->register_count; ++j) put(file, f->registers[j], 1);
        for (uint32_t j = 0; j < f->argument_count; ++j) put(file, f->arguments[j], 4);
        for (uint32_t j = 0; j < f->switch_count; ++j) {
            put(file, (uint32_t)f->switch_entries[j].value, 4);
            put(file, f->switch_entries[j].target, 4);
        }
        for (uint32_t j = 0; j < f->code_count; ++j) {
            Instruction i = f->code[j];
            put(file, i.op, 1); put(file, i.dst, 4); put(file, i.a, 4); put(file, i.b, 4);
            put(file, i.c, 4); put(file, i.line, 4); put(file, i.column, 4);
        }
    }
    bool error = ferror(file) != 0;
    if (fclose(file)) error = true;
    if (error) { ctx->status = 74; fail(ctx, 0, 0, "cannot write bytecode output"); }
}

Program *read_bytecode(Context *ctx, const unsigned char *data, size_t size) {
    Reader r = { ctx, data, size, 0 };
    if (get(&r, 4) != UINT32_C(0x0043424c)) fail(ctx, 0, 0, "invalid bytecode magic");
    uint32_t major = get(&r, 2), minor = get(&r, 2);
    if (major != L_BC_MAJOR || minor != L_BC_MINOR) fail(ctx, 0, 0, "unsupported bytecode version %u.%u", major, minor);
    Program *p = allocate(ctx, sizeof(*p));
    p->function_count = get(&r, 4); p->entry = get(&r, 4);
    if (!p->function_count || p->function_count > L_MAX_FUNCTIONS) fail(ctx, 0, 0, "invalid bytecode function count");
    p->functions = allocate(ctx, p->function_count * sizeof(*p->functions));
    for (uint32_t n = 0; n < p->function_count; ++n) {
        IrFunction *f = &p->functions[n];
        uint32_t length = get(&r, 4);
        if (!length || length > r.size - r.at) fail(ctx, 0, 0, "invalid bytecode function name");
        if (memchr(r.data + r.at, 0, length)) fail(ctx, 0, 0, "NUL byte in function name");
        f->name = copy_text(ctx, (const char *)r.data + r.at, length); r.at += length;
        f->result = (Type)get(&r, 1); f->parameter_count = get(&r, 4); f->slot_count = get(&r, 4);
        f->register_count = get(&r, 4); f->code_count = get(&r, 4); f->argument_count = get(&r, 4);
        f->switch_count = get(&r, 4);
        if (f->slot_count > L_MAX_SLOTS || f->register_count > L_MAX_REGISTERS ||
            f->code_count > L_MAX_CODE || f->argument_count > L_MAX_ARGS ||
            f->switch_count > L_MAX_CASES) fail(ctx, 0, 0, "bytecode resource limit exceeded");
        f->slots = allocate(ctx, f->slot_count * sizeof(*f->slots));
        f->registers = allocate(ctx, f->register_count * sizeof(*f->registers));
        f->arguments = allocate(ctx, f->argument_count * sizeof(*f->arguments));
        f->switch_entries = allocate(ctx, f->switch_count * sizeof(*f->switch_entries));
        f->code = allocate(ctx, f->code_count * sizeof(*f->code));
        for (uint32_t j = 0; j < f->slot_count; ++j) f->slots[j] = (Type)get(&r, 1);
        f->slot_lengths = allocate(ctx, f->slot_count * sizeof(*f->slot_lengths));
        uint32_t elements = 0;
        for (uint32_t j = 0; j < f->slot_count; ++j) {
            f->slot_lengths[j] = get(&r, 4);
            if (f->slot_lengths[j] > L_MAX_ARRAY) fail(ctx, 0, 0, "bytecode array length out of range");
            if (elements > L_MAX_SLOTS_ELEMENTS - f->slot_lengths[j]) fail(ctx, 0, 0, "bytecode exceeds the array element limit");
            elements += f->slot_lengths[j];
        }
        for (uint32_t j = 0; j < f->register_count; ++j) f->registers[j] = (Type)get(&r, 1);
        for (uint32_t j = 0; j < f->argument_count; ++j) f->arguments[j] = get(&r, 4);
        for (uint32_t j = 0; j < f->switch_count; ++j) {
            uint32_t value = get(&r, 4);
            f->switch_entries[j].value = value <= INT32_MAX ? (int32_t)value :
                (int32_t)((int64_t)value - INT64_C(4294967296));
            f->switch_entries[j].target = get(&r, 4);
        }
        for (uint32_t j = 0; j < f->code_count; ++j) {
            Instruction *i = &f->code[j];
            i->op = (Opcode)get(&r, 1); i->dst = get(&r, 4); i->a = get(&r, 4); i->b = get(&r, 4);
            i->c = get(&r, 4); i->line = get(&r, 4); i->column = get(&r, 4);
        }
    }
    if (r.at != r.size) fail(ctx, 0, 0, "trailing data after bytecode");
    verify(ctx, p);
    return p;
}

void inspect(const Program *p, FILE *file) {
    static const char *const names[] = {
        "const", "load", "store", "add.checked", "sub.checked", "mul.checked", "div.checked", "rem.checked",
        "neg.checked", "not", "eq", "ne", "lt", "le", "gt", "ge", "jump", "branch", "call", "return",
        "bounds_check", "clear", "switch", "trap"
    };
    fprintf(file, "LIR %u.%u; bytecode %u.%u; entry f%u\n", L_IR_MAJOR, L_IR_MINOR, L_BC_MAJOR, L_BC_MINOR, p->entry);
    for (uint32_t n = 0; n < p->function_count; ++n) {
        const IrFunction *f = &p->functions[n];
        fprintf(file, "f%u %s -> %s (%u parameters, %u slots, %u registers, %u switch cases)\n", n, f->name,
                type_name(f->result), f->parameter_count, f->slot_count, f->register_count, f->switch_count);
        for (uint32_t j = 0; j < f->slot_count; ++j)
            fprintf(file, "  slot s%u: %s length=%u (0=scalar)\n", j, type_name(f->slots[j]), f->slot_lengths[j]);
        for (uint32_t j = 0; j < f->switch_count; ++j)
            fprintf(file, "  case %d -> pc %u\n", f->switch_entries[j].value, f->switch_entries[j].target);
        for (uint32_t j = 0; j < f->code_count; ++j) {
            Instruction i = f->code[j];
            fprintf(file, "  %04u %-12s dst=%u a=%u b=%u c=%u @%u:%u\n", j, names[i.op], i.dst, i.a, i.b, i.c, i.line, i.column);
        }
    }
}
