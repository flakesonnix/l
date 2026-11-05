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
static char *get_name(Reader *r) {
    uint32_t length = get(r, 4);
    if (!length || length > r->size - r->at) fail(r->ctx, 0, 0, "invalid bytecode symbol name");
    if (memchr(r->data + r->at, 0, length)) fail(r->ctx, 0, 0, "NUL byte in symbol name");
    char *name = copy_text(r->ctx, (const char *)r->data + r->at, length); r->at += length;
    return name;
}
static int32_t get_signed(Reader *r) {
    uint32_t value = get(r, 4);
    return value <= INT32_MAX ? (int32_t)value : (int32_t)((int64_t)value - INT64_C(4294967296));
}

void write_bytecode(Context *ctx, const Program *p, const char *path) {
    FILE *file = fopen(path, "wb");
    if (!file) { ctx->status = 74; fail(ctx, 0, 0, "cannot open bytecode output"); }
    fwrite("LBC\0", 1, 4, file);
    put(file, L_BC_MAJOR, 2); put(file, L_BC_MINOR, 2);
    put(file, p->function_count, 4); put(file, p->entry, 4);
    put(file, p->global_count, 4);
    put(file, p->struct_count, 4);
    put(file, p->enum_count, 4);
    put(file, p->string_count, 4);
    for (uint32_t n = 0; n < p->struct_count; ++n) {
        const IrStruct *s = &p->structs[n];
        uint32_t length = (uint32_t)strlen(s->name);
        put(file, length, 4); fwrite(s->name, 1, length, file); put(file, s->field_count, 4);
        for (uint32_t j = 0; j < s->field_count; ++j) {
            length = (uint32_t)strlen(s->fields[j].name);
            put(file, length, 4); fwrite(s->fields[j].name, 1, length, file); put(file, s->fields[j].type, 4);
        }
    }
    for (uint32_t n = 0; n < p->enum_count; ++n) {
        const IrEnum *e = &p->enums[n];
        uint32_t length = (uint32_t)strlen(e->name);
        put(file, length, 4); fwrite(e->name, 1, length, file); put(file, e->member_count, 4);
        for (uint32_t j = 0; j < e->member_count; ++j) {
            length = (uint32_t)strlen(e->members[j].name);
            put(file, length, 4); fwrite(e->members[j].name, 1, length, file); put(file, (uint32_t)e->members[j].value, 4);
        }
    }
    for (uint32_t n = 0; n < p->string_count; ++n) {
        put(file, p->strings[n].length, 4); fwrite(p->strings[n].bytes, 1, p->strings[n].length, file);
    }
    for (uint32_t n = 0; n < p->global_count; ++n) {
        const IrGlobal *g = &p->globals[n];
        uint32_t length = (uint32_t)strlen(g->name);
        put(file, length, 4); fwrite(g->name, 1, length, file);
        put(file, g->type, 4); put(file, (uint32_t)g->initial, 4); put(file, g->length, 4);
    }
    for (uint32_t n = 0; n < p->function_count; ++n) {
        const IrFunction *f = &p->functions[n];
        uint32_t length = (uint32_t)strlen(f->name);
        put(file, length, 4); fwrite(f->name, 1, length, file);
        put(file, f->result, 4); put(file, f->parameter_count, 4); put(file, f->slot_count, 4);
        put(file, f->register_count, 4); put(file, f->code_count, 4); put(file, f->argument_count, 4);
        put(file, f->switch_count, 4);
        for (uint32_t j = 0; j < f->slot_count; ++j) put(file, f->slots[j], 4);
        for (uint32_t j = 0; j < f->slot_count; ++j) put(file, f->slot_lengths[j], 4);
        for (uint32_t j = 0; j < f->register_count; ++j) put(file, f->registers[j], 4);
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
    p->global_count = get(&r, 4);
    if (p->global_count > L_MAX_GLOBALS) fail(ctx, 0, 0, "bytecode global limit exceeded");
    p->struct_count = get(&r, 4);
    if (p->struct_count > L_MAX_STRUCTS) fail(ctx, 0, 0, "bytecode struct limit exceeded");
    p->enum_count = get(&r, 4);
    if (p->enum_count > L_MAX_ENUMS) fail(ctx, 0, 0, "bytecode enum limit exceeded");
    p->string_count = get(&r, 4);
    if (p->string_count > L_MAX_STRINGS) fail(ctx, 0, 0, "bytecode string limit exceeded");
    p->structs = allocate(ctx, p->struct_count * sizeof(*p->structs));
    for (uint32_t n = 0; n < p->struct_count; ++n) {
        IrStruct *s = &p->structs[n];
        s->name = get_name(&r); s->field_count = get(&r, 4);
        if (!s->field_count || s->field_count > L_MAX_FIELDS) fail(ctx, 0, 0, "invalid bytecode struct field count");
        s->fields = allocate(ctx, s->field_count * sizeof(*s->fields));
        for (uint32_t j = 0; j < s->field_count; ++j) {
            s->fields[j].name = get_name(&r); s->fields[j].type = (Type)get(&r, 4);
        }
    }
    p->enums = allocate(ctx, p->enum_count * sizeof(*p->enums));
    for (uint32_t n = 0; n < p->enum_count; ++n) {
        IrEnum *e = &p->enums[n];
        e->name = get_name(&r); e->member_count = get(&r, 4);
        if (!e->member_count || e->member_count > L_MAX_MEMBERS) fail(ctx, 0, 0, "invalid bytecode enum member count");
        e->members = allocate(ctx, e->member_count * sizeof(*e->members));
        for (uint32_t j = 0; j < e->member_count; ++j) {
            e->members[j].name = get_name(&r); e->members[j].value = get_signed(&r);
        }
    }
    p->strings = allocate(ctx, p->string_count * sizeof(*p->strings));
    uint32_t string_bytes = 0;
    for (uint32_t n = 0; n < p->string_count; ++n) {
        IrString *string = &p->strings[n]; string->length = get(&r, 4);
        if (string->length > L_MAX_STRING) fail(ctx, 0, 0, "bytecode string length exceeds limit");
        if (string->length > L_MAX_STRING_BYTES - string_bytes) fail(ctx, 0, 0, "bytecode string table exceeds byte limit");
        string_bytes += string->length;
        if (string->length > r.size - r.at) fail(ctx, 0, 0, "truncated bytecode string");
        string->bytes = (const unsigned char *)copy_text(ctx, (const char *)r.data + r.at, string->length); r.at += string->length;
    }
    p->globals = allocate(ctx, p->global_count * sizeof(*p->globals));
    uint32_t global_elements = 0;
    for (uint32_t n = 0; n < p->global_count; ++n) {
        IrGlobal *g = &p->globals[n];
        g->name = get_name(&r); g->type = (Type)get(&r, 4); g->initial = get_signed(&r);
        g->length = get(&r, 4);
        if (g->length > L_MAX_ARRAY) fail(ctx, 0, 0, "bytecode global array length out of range");
        if (g->length > L_MAX_GLOBAL_ELEMENTS - global_elements) fail(ctx, 0, 0, "bytecode global array element limit exceeded");
        global_elements += g->length;
    }
    p->functions = allocate(ctx, p->function_count * sizeof(*p->functions));
    for (uint32_t n = 0; n < p->function_count; ++n) {
        IrFunction *f = &p->functions[n];
        f->name = get_name(&r);
        f->result = (Type)get(&r, 4); f->parameter_count = get(&r, 4); f->slot_count = get(&r, 4);
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
        for (uint32_t j = 0; j < f->slot_count; ++j) f->slots[j] = (Type)get(&r, 4);
        f->slot_lengths = allocate(ctx, f->slot_count * sizeof(*f->slot_lengths));
        uint32_t elements = 0;
        for (uint32_t j = 0; j < f->slot_count; ++j) {
            f->slot_lengths[j] = get(&r, 4);
            if (f->slot_lengths[j] > L_MAX_ARRAY) fail(ctx, 0, 0, "bytecode array length out of range");
            if (elements > L_MAX_SLOTS_ELEMENTS - f->slot_lengths[j]) fail(ctx, 0, 0, "bytecode exceeds the array element limit");
            elements += f->slot_lengths[j];
        }
        for (uint32_t j = 0; j < f->register_count; ++j) f->registers[j] = (Type)get(&r, 4);
        for (uint32_t j = 0; j < f->argument_count; ++j) f->arguments[j] = get(&r, 4);
        for (uint32_t j = 0; j < f->switch_count; ++j) {
            f->switch_entries[j].value = get_signed(&r);
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

static const char *ir_type_name(const Program *p, Type type) {
    if (IS_ENUM(type)) return p->enums[type - TY_ENUM].name;
    return IS_STRUCT(type) ? p->structs[type - TY_STRUCT].name : type_name(type);
}
void inspect(const Program *p, FILE *file) {
    static const char *const names[] = {
        "const", "load", "store", "add.checked", "sub.checked", "mul.checked", "div.checked", "rem.checked",
        "neg.checked", "not", "eq", "ne", "lt", "le", "gt", "ge", "jump", "branch", "call", "return",
        "bounds_check", "clear", "switch", "trap", "global.load", "global.store", "struct.make", "field.load", "field.store",
        "byte.checked", "byte.to_int", "string.length", "string.index",
        "io.read_byte", "io.write_byte", "io.write_string", "io.write_error"
    };
    fprintf(file, "LIR %u.%u; bytecode %u.%u; entry f%u\n", L_IR_MAJOR, L_IR_MINOR, L_BC_MAJOR, L_BC_MINOR, p->entry);
    for (uint32_t n = 0; n < p->string_count; ++n) {
        fprintf(file, "string k%u length=%u hex=", n, p->strings[n].length);
        for (uint32_t j = 0; j < p->strings[n].length; ++j) fprintf(file, "%02x", p->strings[n].bytes[j]);
        fputc('\n', file);
    }
    for (uint32_t n = 0; n < p->enum_count; ++n) {
        const IrEnum *e = &p->enums[n];
        fprintf(file, "enum t%u %s (%u members)\n", TY_ENUM + n, e->name, e->member_count);
        for (uint32_t j = 0; j < e->member_count; ++j)
            fprintf(file, "  member %s = %d\n", e->members[j].name, e->members[j].value);
    }
    for (uint32_t n = 0; n < p->struct_count; ++n) {
        const IrStruct *s = &p->structs[n];
        fprintf(file, "struct t%u %s (%u fields)\n", TY_STRUCT + n, s->name, s->field_count);
        for (uint32_t j = 0; j < s->field_count; ++j)
            fprintf(file, "  field %u %s: %s\n", j, s->fields[j].name, ir_type_name(p, s->fields[j].type));
    }
    for (uint32_t n = 0; n < p->global_count; ++n)
        fprintf(file, "global g%u %s: %s initial=%d length=%u (0=scalar)\n", n, p->globals[n].name,
            ir_type_name(p, p->globals[n].type), p->globals[n].initial, p->globals[n].length);
    for (uint32_t n = 0; n < p->function_count; ++n) {
        const IrFunction *f = &p->functions[n];
        fprintf(file, "f%u %s -> %s (%u parameters, %u slots, %u registers, %u switch cases)\n", n, f->name,
                ir_type_name(p, f->result), f->parameter_count, f->slot_count, f->register_count, f->switch_count);
        for (uint32_t j = 0; j < f->slot_count; ++j)
            fprintf(file, "  slot s%u: %s length=%u (0=scalar)\n", j, ir_type_name(p, f->slots[j]), f->slot_lengths[j]);
        for (uint32_t j = 0; j < f->switch_count; ++j)
            fprintf(file, "  case %d -> pc %u\n", f->switch_entries[j].value, f->switch_entries[j].target);
        for (uint32_t j = 0; j < f->code_count; ++j) {
            Instruction i = f->code[j];
            fprintf(file, "  %04u %-12s dst=%u a=%u b=%u c=%u @%u:%u\n", j, names[i.op], i.dst, i.a, i.b, i.c, i.line, i.column);
        }
    }
}
