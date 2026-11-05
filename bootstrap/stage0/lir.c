#include "l.h"

#include <string.h>

typedef struct Breakable Breakable;
struct Breakable { bool is_loop; uint32_t breaks, continues; Breakable *parent; };
typedef struct { Context *ctx; Program *program; IrFunction *fn; Breakable *breakables; } Lower;
static uint32_t lower_expr(Lower *, Expr *);
static bool lower_stmt(Lower *, Stmt *);

static uint32_t slot(Lower *l, Type type) {
    if (l->fn->slot_count == L_MAX_SLOTS) fail(l->ctx, 0, 0, "too many LIR slots");
    uint32_t result = l->fn->slot_count++;
    l->fn->slots[result] = type;
    return result;
}
static uint32_t reg(Lower *l, Type type) {
    IrFunction *f = l->fn;
    if (f->register_count == L_MAX_REGISTERS) fail(l->ctx, 0, 0, "too many LIR registers");
    reserve(l->ctx, (void **)&f->registers, &f->register_capacity, f->register_count + 1, sizeof(*f->registers));
    f->registers[f->register_count] = type;
    return f->register_count++;
}
static uint32_t emit(Lower *l, Token t, Opcode op, uint32_t dst, uint32_t a, uint32_t b, uint32_t c) {
    IrFunction *f = l->fn;
    if (f->code_count == L_MAX_CODE) token_fail(l->ctx, t, "too many LIR instructions");
    reserve(l->ctx, (void **)&f->code, &f->code_capacity, f->code_count + 1, sizeof(*f->code));
    f->code[f->code_count] = (Instruction){ op, dst, a, b, c, t.line, t.column };
    return f->code_count++;
}
static uint32_t switch_entry(Lower *l, int32_t value) {
    IrFunction *f = l->fn;
    if (f->switch_count == L_MAX_CASES) fail(l->ctx, 0, 0, "too many switch cases");
    reserve(l->ctx, (void **)&f->switch_entries, &f->switch_capacity, f->switch_count + 1, sizeof(*f->switch_entries));
    f->switch_entries[f->switch_count].value = value;
    f->switch_entries[f->switch_count].target = 0;
    return f->switch_count++;
}
static void patch_jumps(Lower *l, uint32_t head, uint32_t target) {
    /* Pending jumps form a list through operand a until the control-flow target is known. */
    while (head != L_NONE) {
        uint32_t next = l->fn->code[head].a;
        l->fn->code[head].a = target;
        head = next;
    }
}
static uint32_t constant(Lower *l, Token t, Type type, int32_t value) {
    uint32_t r = reg(l, type);
    emit(l, t, OP_CONST, r, (uint32_t)value, 0, 0);
    return r;
}
static Opcode binary_op(int op) {
    switch (op) {
    case '+': return OP_ADD; case '-': return OP_SUB; case '*': return OP_MUL;
    case '/': return OP_DIV; case '%': return OP_REM; case TK_EQ: return OP_EQ;
    case TK_NE: return OP_NE; case '<': return OP_LT; case '>': return OP_GT;
    case TK_LE: return OP_LE; default: return OP_GE;
    }
}
static uint32_t lower_expr(Lower *l, Expr *e) {
    uint32_t a, b, r;
    switch (e->kind) {
    case EX_INT: case EX_BOOL: case EX_STRING: return constant(l, e->token, e->type, (int32_t)e->integer);
    case EX_LENGTH:
        a = lower_expr(l, e->left); r = reg(l, TY_INT);
        emit(l, e->token, OP_STRING_LENGTH, r, a, 0, 0); return r;
    case EX_STRING_INDEX:
        a = lower_expr(l, e->left); b = lower_expr(l, e->right); r = reg(l, TY_BYTE);
        emit(l, e->token, OP_STRING_INDEX, r, a, b, 0); return r;
    case EX_CONVERT:
        a = lower_expr(l, e->left); r = reg(l, e->type);
        emit(l, e->token, e->type == TY_BYTE ? OP_TO_BYTE : OP_TO_INT, r, a, 0, 0); return r;
    case EX_NAME:
        r = reg(l, e->type); emit(l, e->token, OP_LOAD, r, e->symbol, 0, 0); return r;
    case EX_GLOBAL:
        r = reg(l, e->type); emit(l, e->token, OP_GLOBAL_LOAD, r, e->symbol, 0, 0); return r;
    case EX_FIELD:
        a = lower_expr(l, e->left); r = reg(l, e->type);
        emit(l, e->token, OP_FIELD, r, a, e->symbol, 0); return r;
    case EX_INDEX: {
        uint32_t idx = lower_expr(l, e->right);
        emit(l, e->token, OP_BOUNDS, 0, idx, 0, e->length);
        r = reg(l, e->type);
        emit(l, e->token, OP_LOAD, r, e->symbol, idx, 1);
        return r;
    }
    case EX_ASSIGN:
        if (e->left->kind == EX_FIELD) {
            r = lower_expr(l, e->right);
            emit(l, e->token, OP_FIELD_STORE, e->left->left->symbol, r, e->left->symbol, 0); return r;
        }
        if (e->left->kind == EX_INDEX) {
            /* Left-to-right: the index is evaluated and bounds-checked before the stored value. */
            uint32_t idx = lower_expr(l, e->left->right);
            emit(l, e->token, OP_BOUNDS, 0, idx, 0, e->left->length);
            r = lower_expr(l, e->right);
            emit(l, e->token, OP_STORE, e->left->symbol, r, idx, 1);
            return r;
        }
        r = lower_expr(l, e->right);
        emit(l, e->token, e->left->kind == EX_GLOBAL ? OP_GLOBAL_STORE : OP_STORE, e->left->symbol, r, 0, 0); return r;
    case EX_POSTFIX:
        if (e->left->kind == EX_INDEX) {
            uint32_t idx = lower_expr(l, e->left->right);
            emit(l, e->token, OP_BOUNDS, 0, idx, 0, e->left->length);
            a = reg(l, TY_INT); emit(l, e->token, OP_LOAD, a, e->left->symbol, idx, 1);
            b = constant(l, e->token, TY_INT, 1); r = reg(l, TY_INT);
            emit(l, e->token, e->op == TK_INC ? OP_ADD : OP_SUB, r, a, b, 0);
            emit(l, e->token, OP_STORE, e->left->symbol, r, idx, 1);
            return a;
        }
        a = lower_expr(l, e->left); b = constant(l, e->token, TY_INT, 1); r = reg(l, TY_INT);
        emit(l, e->token, e->op == TK_INC ? OP_ADD : OP_SUB, r, a, b, 0);
        if (e->left->kind == EX_FIELD) {
            emit(l, e->token, OP_FIELD_STORE, e->left->left->symbol, r, e->left->symbol, 0); return a;
        }
        emit(l, e->token, e->left->kind == EX_GLOBAL ? OP_GLOBAL_STORE : OP_STORE, e->left->symbol, r, 0, 0); return a;
    case EX_UNARY:
        a = lower_expr(l, e->left);
        if (e->op == '+') return a;
        r = reg(l, e->type); emit(l, e->token, e->op == '!' ? OP_NOT : OP_NEG, r, a, 0, 0); return r;
    case EX_BINARY:
        a = lower_expr(l, e->left);
        if (e->op == TK_AND || e->op == TK_OR) {
            /* Short-circuiting uses an explicit temporary slot, never eager evaluation. */
            uint32_t temp = slot(l, TY_BOOL);
            emit(l, e->token, OP_STORE, temp, a, 0, 0);
            uint32_t branch = emit(l, e->token, OP_BRANCH, 0, a, 0, 0);
            uint32_t rhs = l->fn->code_count;
            b = lower_expr(l, e->right);
            emit(l, e->token, OP_STORE, temp, b, 0, 0);
            uint32_t jump = emit(l, e->token, OP_JUMP, 0, 0, 0, 0);
            uint32_t end = l->fn->code_count;
            l->fn->code[branch].b = e->op == TK_AND ? rhs : end;
            l->fn->code[branch].c = e->op == TK_AND ? end : rhs;
            l->fn->code[jump].a = end;
            r = reg(l, TY_BOOL); emit(l, e->token, OP_LOAD, r, temp, 0, 0); return r;
        }
        b = lower_expr(l, e->right); r = reg(l, e->type);
        emit(l, e->token, binary_op(e->op), r, a, b, 0); return r;
    case EX_CALL: case EX_STRUCT: {
        /* Evaluate first: nested calls must not split an outer call's argument vector. */
        uint32_t values[L_MAX_SLOTS], count = 0;
        for (ExprList *arg = e->args; arg; arg = arg->next) values[count++] = lower_expr(l, arg->value);
        uint32_t start = l->fn->argument_count;
        if (count > L_MAX_ARGS - start) token_fail(l->ctx, e->token, "too many LIR call arguments");
        reserve(l->ctx, (void **)&l->fn->arguments, &l->fn->argument_capacity, start + count, sizeof(uint32_t));
        if (count) memcpy(l->fn->arguments + start, values, count * sizeof(uint32_t));
        l->fn->argument_count += count;
        r = e->type == TY_VOID ? L_NONE : reg(l, e->type);
        if (e->kind == EX_STRUCT) emit(l, e->token, OP_STRUCT, r, start, count, 0);
        else emit(l, e->token, OP_CALL, r, e->symbol, start, count);
        return r;
    }
    default: token_fail(l->ctx, e->token, "invalid AST expression during lowering");
    }
}
static bool lower_stmt(Lower *l, Stmt *s) {
    switch (s->kind) {
    case ST_BLOCK:
        for (Stmt *child = s->body; child; child = child->next) if (!lower_stmt(l, child)) return false;
        break;
    case ST_DECL: {
        if (s->decl->array) { emit(l, s->token, OP_CLEAR, s->decl->slot, 0, 0, 0); break; }
        uint32_t value = lower_expr(l, s->decl->value);
        emit(l, s->token, OP_STORE, s->decl->slot, value, 0, 0); break;
    }
    case ST_EXPR: (void)lower_expr(l, s->expr); break;
    case ST_RETURN: {
        uint32_t value = s->expr ? lower_expr(l, s->expr) : L_NONE;
        emit(l, s->token, OP_RETURN, 0, value, 0, 0); return false;
    }
    case ST_BREAK: case ST_CONTINUE: {
        if (!l->breakables) token_fail(l->ctx, s->token, "break/continue outside a loop or switch during lowering");
        Breakable *target = l->breakables;
        if (s->kind == ST_CONTINUE)
            while (target && !target->is_loop) target = target->parent;
        if (!target) token_fail(l->ctx, s->token, "continue requires an enclosing loop during lowering");
        uint32_t *head = s->kind == ST_CONTINUE ? &target->continues : &target->breaks;
        *head = emit(l, s->token, OP_JUMP, 0, *head, 0, 0);
        return false;
    }
    case ST_IF: {
        uint32_t cond = lower_expr(l, s->condition);
        uint32_t branch = emit(l, s->token, OP_BRANCH, 0, cond, l->fn->code_count + 1, 0);
        bool then_falls = lower_stmt(l, s->body);
        uint32_t jump = then_falls ? emit(l, s->token, OP_JUMP, 0, 0, 0, 0) : L_NONE;
        l->fn->code[branch].c = l->fn->code_count;
        bool else_falls = s->other ? lower_stmt(l, s->other) : true;
        if (then_falls) l->fn->code[jump].a = l->fn->code_count;
        return then_falls || else_falls;
    }
    case ST_FOR: case ST_WHILE: {
        if (s->init) (void)lower_stmt(l, s->init);
        uint32_t start = l->fn->code_count;
        uint32_t cond = s->condition ? lower_expr(l, s->condition) : constant(l, s->token, TY_BOOL, 1);
        uint32_t branch = emit(l, s->token, OP_BRANCH, 0, cond, l->fn->code_count + 1, 0);
        Breakable loop = { true, L_NONE, L_NONE, l->breakables };
        l->breakables = &loop;
        bool body_falls = lower_stmt(l, s->body);
        l->breakables = loop.parent;
        if (body_falls || loop.continues != L_NONE) {
            /* for-continues run the step; while-continues recheck the condition. */
            patch_jumps(l, loop.continues, l->fn->code_count);
            if (s->step) (void)lower_expr(l, s->step);
            emit(l, s->token, OP_JUMP, 0, start, 0, 0);
        }
        l->fn->code[branch].c = l->fn->code_count;
        patch_jumps(l, loop.breaks, l->fn->code_count);
        break;
    }
    case ST_SWITCH: {
        uint32_t selector = lower_expr(l, s->expr);
        uint32_t first = l->fn->switch_count, count = 0;
        for (SwitchCase *label = s->cases; label; label = label->next)
            if (!label->is_default) switch_entry(l, label->value), ++count;
        /* OP_SWITCH: a=selector reg, b=first entry, c=case count, dst=default/fallthrough target. */
        uint32_t switch_pc = emit(l, s->token, OP_SWITCH, L_NONE, selector, first, count);
        Breakable sw = { false, L_NONE, L_NONE, l->breakables };
        l->breakables = &sw;
        bool tail_falls = true;
        uint32_t case_index = 0;
        uint32_t default_target = L_NONE;
        for (SwitchCase *label = s->cases; label; label = label->next) {
            uint32_t target = l->fn->code_count;
            if (label->is_default) default_target = target;
            else l->fn->switch_entries[first + case_index++].target = target;
            tail_falls = true;
            for (Stmt *child = label->body; child; child = child->next) {
                if (!lower_stmt(l, child)) { tail_falls = false; break; }
            }
        }
        l->breakables = sw.parent;
        uint32_t after = l->fn->code_count;
        l->fn->code[switch_pc].dst = default_target != L_NONE ? default_target : after;
        patch_jumps(l, sw.breaks, after);
        return sw.breaks != L_NONE || default_target == L_NONE || tail_falls;
    }
    case ST_EMPTY: break;
    default: token_fail(l->ctx, s->token, "invalid AST statement during lowering");
    }
    return true;
}

static char *linked_name(Context *ctx, const Module *module, Token scope, Token name) {
    name = join_name(ctx, scope, name, "::");
    name = join_name(ctx, module->qualifier, name, "::");
    Token package = {.text = module->package, .length = strlen(module->package)};
    name = join_name(ctx, package, name, "::");
    return copy_text(ctx, name.text, name.length);
}
Program *lower(Context *ctx, Ast *ast) {
    const char *saved = ctx->filename;
    Program *p = allocate(ctx, sizeof(*p));
    p->string_count = ast->string_count; p->strings = ast->strings;
    p->function_count = ast->function_count;
    p->functions = allocate(ctx, p->function_count * sizeof(*p->functions));
    p->enum_count = ast->enum_count;
    p->enums = allocate(ctx, p->enum_count * sizeof(*p->enums));
    for (Enum *enumeration = ast->enums; enumeration; enumeration = enumeration->next) {
        IrEnum *e = &p->enums[enumeration->symbol];
        e->name = linked_name(ctx, enumeration->module, enumeration->scope, enumeration->name);
        e->member_count = enumeration->member_count;
        e->members = allocate(ctx, e->member_count * sizeof(*e->members));
        uint32_t index = 0;
        for (Global *member = enumeration->members; member; member = member->next, ++index) {
            e->members[index].name = copy_text(ctx, member->name.text, member->name.length);
            e->members[index].value = member->integer;
        }
    }
    p->struct_count = ast->struct_count;
    p->structs = allocate(ctx, p->struct_count * sizeof(*p->structs));
    for (Struct *record = ast->structs; record; record = record->next) {
        IrStruct *s = &p->structs[record->symbol];
        s->name = linked_name(ctx, record->module, record->scope, record->name); s->field_count = record->field_count;
        s->fields = allocate(ctx, s->field_count * sizeof(*s->fields));
        uint32_t field_index = 0;
        for (Field *field = record->fields; field; field = field->next, ++field_index) {
            s->fields[field_index].name = copy_text(ctx, field->name.text, field->name.length);
            s->fields[field_index].type = field->type;
        }
    }
    p->global_count = ast->static_count;
    p->globals = allocate(ctx, p->global_count * sizeof(*p->globals));
    for (Global *global = ast->globals; global; global = global->next) {
        if (!global->is_static) continue;
        IrGlobal *g = &p->globals[global->symbol];
        g->name = linked_name(ctx, global->module, global->scope, global->name);
        g->type = global->type; g->initial = global->integer;
    }
    uint32_t index = 0;
    for (Function *fn = ast->functions; fn; fn = fn->next, ++index) {
        IrFunction *f = &p->functions[index];
        ctx->filename = f->source_path = fn->module->path;
        f->name = linked_name(ctx, fn->module, fn->scope, fn->name);
        f->result = fn->result; f->parameter_count = fn->parameter_count; f->slot_count = fn->slot_count;
        f->slots = allocate(ctx, L_MAX_SLOTS * sizeof(*f->slots));
        f->slot_lengths = allocate(ctx, L_MAX_SLOTS * sizeof(*f->slot_lengths));
        memcpy(f->slots, fn->slots, fn->slot_count * sizeof(*f->slots));
        memcpy(f->slot_lengths, fn->lengths, fn->slot_count * sizeof(*f->slot_lengths));
        if (fn == ast->entrypoint) p->entry = index;
        Lower l = { ctx, p, f, NULL };
        if (fn->is_extern) {
            /* Intrinsics keep normal call signatures but receive fixed VM bodies. */
            if (fn->intrinsic == IN_READ_BYTE) {
                uint32_t r = reg(&l, TY_INT);
                emit(&l, fn->name, OP_READ_BYTE, r, 0, 0, 0);
                emit(&l, fn->name, OP_RETURN, 0, r, 0, 0);
            } else {
                uint32_t r = reg(&l, fn->intrinsic == IN_WRITE_BYTE ? TY_BYTE : TY_STRING);
                emit(&l, fn->name, OP_LOAD, r, 0, 0, 0);
                emit(&l, fn->name, fn->intrinsic == IN_WRITE_BYTE ? OP_WRITE_BYTE :
                    fn->intrinsic == IN_WRITE_ERROR ? OP_WRITE_ERROR : OP_WRITE_STRING, L_NONE, r, 0, 0);
                emit(&l, fn->name, OP_RETURN, 0, L_NONE, 0, 0);
            }
            continue;
        }
        if (lower_stmt(&l, fn->body)) emit(&l, fn->name, OP_RETURN, 0, L_NONE, 0, 0);
    }
    ctx->filename = saved;
    return p;
}

static _Noreturn void invalid(Context *ctx, const char *reason) { fail(ctx, 0, 0, "invalid LIR/bytecode: %s", reason); }
static Type register_type(Context *ctx, const IrFunction *f, uint32_t r) {
    if (r >= f->register_count) invalid(ctx, "register index out of range");
    return f->registers[r];
}
static Type slot_type(Context *ctx, const IrFunction *f, uint32_t r) {
    if (r >= f->slot_count) invalid(ctx, "slot index out of range");
    return f->slots[r];
}
static Type global_type(Context *ctx, const Program *p, uint32_t index) {
    if (index >= p->global_count) invalid(ctx, "global index out of range");
    return p->globals[index].type;
}
static bool scalar_type(const Program *p, Type type) {
    return type == TY_INT || type == TY_BOOL || type == TY_BYTE || type == TY_STRING || (IS_ENUM(type) && (uint32_t)(type - TY_ENUM) < p->enum_count);
}
static bool value_type(const Program *p, Type type) {
    return scalar_type(p, type) || (IS_STRUCT(type) && (uint32_t)(type - TY_STRUCT) < p->struct_count);
}
static void enum_value(Context *ctx, const Program *p, Type type, uint32_t value) {
    if (!IS_ENUM(type)) return;
    const IrEnum *e = &p->enums[type - TY_ENUM]; /* Type IDs and metadata have already been validated. */
    for (uint32_t j = 0; j < e->member_count; ++j)
        if ((uint32_t)e->members[j].value == value) return;
    invalid(ctx, "value is not a declared enum member");
}
static const IrStruct *struct_type(Context *ctx, const Program *p, Type type) {
    if (!IS_STRUCT(type)) invalid(ctx, "expected a struct type");
    return &p->structs[type - TY_STRUCT]; /* Value type IDs have already been validated. */
}
static Type field_type(Context *ctx, const IrStruct *record, uint32_t index) {
    if (index >= record->field_count) invalid(ctx, "field index out of range");
    return record->fields[index].type;
}
static void same(Context *ctx, Type a, Type b) {
    if (a != b) invalid(ctx, "operand type mismatch");
}
static void access_mode(Context *ctx, const IrFunction *f, uint32_t slot, Instruction i) {
    (void)slot_type(ctx, f, slot);
    if (i.c > 1) invalid(ctx, "invalid addressing mode");
    if ((f->slot_lengths[slot] != 0) != (i.c == 1)) invalid(ctx, "slot shape does not match addressing mode");
    if (i.c) same(ctx, register_type(ctx, f, i.b), TY_INT);
}
static bool defines(Opcode op) {
    return op <= OP_LOAD || (op >= OP_ADD && op <= OP_GE) || op == OP_CALL || op == OP_GLOBAL_LOAD ||
        op == OP_STRUCT || op == OP_FIELD || op == OP_TO_BYTE || op == OP_TO_INT || op == OP_STRING_LENGTH ||
        op == OP_STRING_INDEX || op == OP_READ_BYTE;
}
static unsigned successors(Context *ctx, const IrFunction *f, uint32_t pc, uint32_t next[L_MAX_CASES + 1]) {
    Instruction i = f->code[pc];
    unsigned count = 0;
    if (i.op == OP_RETURN || i.op == OP_TRAP) return 0;
    if (i.op == OP_JUMP) { next[count++] = i.a; }
    else if (i.op == OP_BRANCH) { next[count++] = i.b; next[count++] = i.c; }
    else if (i.op == OP_SWITCH) {
        if (i.dst != L_NONE) next[count++] = i.dst;
        for (uint32_t j = i.b; j < i.b + i.c; ++j) next[count++] = f->switch_entries[j].target;
    }
    else { next[count++] = pc + 1; }
    for (unsigned n = 0; n < count; ++n) if (next[n] >= f->code_count) invalid(ctx, "control flow leaves function");
    return count;
}
static void set_bit(uint64_t *bits, uint32_t bit) { bits[bit / 64] |= UINT64_C(1) << (bit % 64); }
static void use(Context *ctx, const uint64_t *bits, uint32_t bit) {
    if (!(bits[bit / 64] & (UINT64_C(1) << (bit % 64)))) invalid(ctx, "value does not dominate use or slot is uninitialized");
}
static void dataflow(Context *ctx, const IrFunction *f, bool **seen_out) {
    size_t words = ((size_t)f->register_count + f->slot_count + 63) / 64;
    /* Empty void functions still need a nonzero row size. */
    if (!words) words = 1;
    uint64_t *state = allocate(ctx, f->code_count * words * sizeof(*state));
    uint64_t *out = allocate(ctx, words * sizeof(*out));
    bool *seen = allocate(ctx, f->code_count * sizeof(*seen));
    bool *queued = allocate(ctx, f->code_count * sizeof(*queued));
    uint32_t *queue = allocate(ctx, f->code_count * sizeof(*queue));
    size_t head = 0, tail = 0, pending = 1;
    queue[tail++] = 0; seen[0] = queued[0] = true;
    for (uint32_t j = 0; j < f->parameter_count; ++j) set_bit(state, f->register_count + j);
    while (pending) {
        uint32_t pc = queue[head++ % f->code_count]; --pending; queued[pc] = false;
        memcpy(out, state + pc * words, words * sizeof(*out));
        Instruction i = f->code[pc];
        if (defines(i.op) && i.dst != L_NONE) set_bit(out, i.dst);
        if (i.op == OP_CLEAR || (i.op == OP_STORE && !i.c)) set_bit(out, f->register_count + i.dst);
        uint32_t next[L_MAX_CASES + 1];
        unsigned count = successors(ctx, f, pc, next);
        for (unsigned j = 0; j < count; ++j) {
            uint32_t target = next[j];
            uint64_t *into = state + target * words;
            bool changed = !seen[target];
            for (size_t w = 0; w < words; ++w) {
                uint64_t value = seen[target] ? into[w] & out[w] : out[w];
                if (value != into[w]) changed = true;
                into[w] = value;
            }
            seen[target] = true;
            if (changed && !queued[target]) { queue[tail++ % f->code_count] = target; ++pending; queued[target] = true; }
        }
    }
    for (uint32_t pc = 0; pc < f->code_count; ++pc) {
        if (!seen[pc]) continue;
        const uint64_t *bits = state + pc * words;
        Instruction i = f->code[pc];
        switch (i.op) {
        case OP_LOAD:
            use(ctx, bits, f->register_count + i.a);
            if (i.c) use(ctx, bits, i.b);
            break;
        case OP_STORE:
            use(ctx, bits, i.a);
            if (i.c) { use(ctx, bits, f->register_count + i.dst); use(ctx, bits, i.b); }
            break;
        case OP_GLOBAL_STORE: use(ctx, bits, i.a); break;
        case OP_FIELD_STORE: use(ctx, bits, f->register_count + i.dst); use(ctx, bits, i.a); break;
        case OP_FIELD: use(ctx, bits, i.a); break;
        case OP_STRUCT:
            for (uint32_t j = 0; j < i.b; ++j) use(ctx, bits, f->arguments[i.a + j]);
            break;
        case OP_NEG: case OP_NOT: case OP_BRANCH: case OP_TO_BYTE: case OP_TO_INT: case OP_STRING_LENGTH:
        case OP_WRITE_BYTE: case OP_WRITE_STRING: case OP_WRITE_ERROR: use(ctx, bits, i.a); break;
        case OP_ADD: case OP_SUB: case OP_MUL: case OP_DIV: case OP_REM:
        case OP_EQ: case OP_NE: case OP_LT: case OP_LE: case OP_GT: case OP_GE: case OP_STRING_INDEX:
            use(ctx, bits, i.a); use(ctx, bits, i.b); break;
        case OP_CALL:
            for (uint32_t j = 0; j < i.c; ++j) use(ctx, bits, f->arguments[i.b + j]);
            break;
        case OP_RETURN: if (i.a != L_NONE) use(ctx, bits, i.a); break;
        case OP_BOUNDS: use(ctx, bits, i.a); break;
        case OP_SWITCH: use(ctx, bits, i.a); break;
        default: break;
        }
    }
    release(ctx, queue); release(ctx, queued); release(ctx, out); release(ctx, state);
    *seen_out = seen;
}

void verify(Context *ctx, const Program *p) {
    const char *saved = ctx->filename;
    if (!p->function_count || p->function_count > L_MAX_FUNCTIONS || p->entry >= p->function_count)
        invalid(ctx, "invalid function table");
    const IrFunction *entry = &p->functions[p->entry];
    if (entry->result != TY_INT || entry->parameter_count) invalid(ctx, "invalid entry signature");
    if (p->string_count > L_MAX_STRINGS) invalid(ctx, "too many strings");
    uint32_t string_bytes = 0;
    for (uint32_t n = 0; n < p->string_count; ++n) {
        uint32_t length = p->strings[n].length;
        if (length > L_MAX_STRING) invalid(ctx, "string length exceeds limit");
        if (length > L_MAX_STRING_BYTES - string_bytes) invalid(ctx, "string table exceeds byte limit");
        string_bytes += length;
    }
    if (p->enum_count > L_MAX_ENUMS) invalid(ctx, "too many enums");
    for (uint32_t n = 0; n < p->enum_count; ++n) {
        const IrEnum *e = &p->enums[n];
        if (!e->member_count || e->member_count > L_MAX_MEMBERS) invalid(ctx, "invalid enum member count");
        for (uint32_t j = 0; j < e->member_count; ++j)
            for (uint32_t k = 0; k < j; ++k)
                if (!strcmp(e->members[k].name, e->members[j].name)) invalid(ctx, "duplicate enum member name");
    }
    if (p->struct_count > L_MAX_STRUCTS) invalid(ctx, "too many structs");
    for (uint32_t n = 0; n < p->struct_count; ++n) {
        const IrStruct *s = &p->structs[n];
        if (!s->field_count || s->field_count > L_MAX_FIELDS) invalid(ctx, "invalid struct field count");
        for (uint32_t j = 0; j < s->field_count; ++j) {
            if (!scalar_type(p, s->fields[j].type)) invalid(ctx, "invalid scalar field type");
            for (uint32_t k = 0; k < j; ++k)
                if (!strcmp(s->fields[k].name, s->fields[j].name)) invalid(ctx, "duplicate struct field name");
        }
    }
    if (p->global_count > L_MAX_GLOBALS) invalid(ctx, "too many globals");
    for (uint32_t n = 0; n < p->global_count; ++n) {
        const IrGlobal *g = &p->globals[n];
        if (!scalar_type(p, g->type)) invalid(ctx, "invalid global type");
        if (g->type == TY_BOOL && (uint32_t)g->initial > 1) invalid(ctx, "invalid bool global initializer");
        if (g->type == TY_BYTE && (uint32_t)g->initial > 255) invalid(ctx, "invalid byte global initializer");
        if (g->type == TY_STRING && (uint32_t)g->initial >= p->string_count) invalid(ctx, "invalid string global initializer");
        enum_value(ctx, p, g->type, (uint32_t)g->initial);
    }
    for (uint32_t n = 0; n < p->function_count; ++n) {
        const IrFunction *f = &p->functions[n];
        ctx->filename = f->source_path ? f->source_path : saved;
        if ((f->result != TY_VOID && !value_type(p, f->result)) || f->parameter_count > f->slot_count || f->slot_count > L_MAX_SLOTS ||
            f->register_count > L_MAX_REGISTERS || !f->code_count || f->code_count > L_MAX_CODE ||
            f->argument_count > L_MAX_ARGS || f->switch_count > L_MAX_CASES) invalid(ctx, "invalid function limits or result type");
        for (uint32_t j = 0; j < f->switch_count; ++j)
            if (f->switch_entries[j].target >= f->code_count) invalid(ctx, "switch target out of range");
        for (uint32_t j = 0; j < f->slot_count; ++j)
            if (!value_type(p, f->slots[j])) invalid(ctx, "invalid slot type");
        uint32_t elements = 0;
        for (uint32_t j = 0; j < f->slot_count; ++j) {
            if (f->slot_lengths[j] > L_MAX_ARRAY) invalid(ctx, "array length out of range");
            if (f->slot_lengths[j] && f->slots[j] != TY_INT && f->slots[j] != TY_BOOL && f->slots[j] != TY_BYTE)
                invalid(ctx, "struct/enum/string arrays are not supported");
            if (j < f->parameter_count && f->slot_lengths[j]) invalid(ctx, "array parameters are not supported");
            if (elements > L_MAX_SLOTS_ELEMENTS - f->slot_lengths[j])
                invalid(ctx, "too many array elements");
            elements += f->slot_lengths[j];
        }
        for (uint32_t j = 0; j < f->register_count; ++j)
            if (!value_type(p, f->registers[j])) invalid(ctx, "invalid register type");
        bool *defined = allocate(ctx, f->register_count * sizeof(*defined));
        for (uint32_t pc = 0; pc < f->code_count; ++pc) {
            Instruction i = f->code[pc];
            if (i.op >= OP_COUNT) invalid(ctx, "unknown opcode");
            if (defines(i.op) && !(i.op == OP_CALL && i.dst == L_NONE)) {
                (void)register_type(ctx, f, i.dst);
                if (defined[i.dst]) invalid(ctx, "multiple SSA definitions");
                defined[i.dst] = true;
            }
            switch (i.op) {
            case OP_CONST:
                if (IS_STRUCT(f->registers[i.dst])) invalid(ctx, "struct value requires struct.make");
                if (f->registers[i.dst] == TY_BOOL && i.a > 1) invalid(ctx, "invalid bool constant");
                if (f->registers[i.dst] == TY_BYTE && i.a > 255) invalid(ctx, "invalid byte constant");
                if (f->registers[i.dst] == TY_STRING && i.a >= p->string_count) invalid(ctx, "invalid string constant");
                enum_value(ctx, p, f->registers[i.dst], i.a);
                break;
            case OP_TO_BYTE: case OP_TO_INT:
                same(ctx, register_type(ctx, f, i.dst), i.op == OP_TO_BYTE ? TY_BYTE : TY_INT);
                same(ctx, register_type(ctx, f, i.a), i.op == OP_TO_BYTE ? TY_INT : TY_BYTE); break;
            case OP_STRING_LENGTH: case OP_STRING_INDEX:
                same(ctx, register_type(ctx, f, i.dst), i.op == OP_STRING_LENGTH ? TY_INT : TY_BYTE);
                same(ctx, register_type(ctx, f, i.a), TY_STRING);
                if (i.op == OP_STRING_INDEX) same(ctx, register_type(ctx, f, i.b), TY_INT);
                break;
            case OP_READ_BYTE:
                same(ctx, register_type(ctx, f, i.dst), TY_INT); break;
            case OP_WRITE_BYTE: case OP_WRITE_STRING: case OP_WRITE_ERROR:
                if (i.dst != L_NONE) invalid(ctx, "stream write defines a register");
                same(ctx, register_type(ctx, f, i.a), i.op == OP_WRITE_BYTE ? TY_BYTE : TY_STRING); break;
            case OP_STRUCT: {
                const IrStruct *s = struct_type(ctx, p, register_type(ctx, f, i.dst));
                if (i.b != s->field_count || i.a > f->argument_count || i.b > f->argument_count - i.a)
                    invalid(ctx, "invalid struct initializer vector");
                for (uint32_t j = 0; j < i.b; ++j)
                    same(ctx, register_type(ctx, f, f->arguments[i.a + j]), s->fields[j].type);
                break;
            }
            case OP_FIELD:
                same(ctx, register_type(ctx, f, i.dst), field_type(ctx, struct_type(ctx, p, register_type(ctx, f, i.a)), i.b)); break;
            case OP_FIELD_STORE:
                same(ctx, register_type(ctx, f, i.a), field_type(ctx, struct_type(ctx, p, slot_type(ctx, f, i.dst)), i.b)); break;
            case OP_LOAD:
                access_mode(ctx, f, i.a, i);
                same(ctx, register_type(ctx, f, i.dst), slot_type(ctx, f, i.a)); break;
            case OP_STORE:
                access_mode(ctx, f, i.dst, i);
                same(ctx, slot_type(ctx, f, i.dst), register_type(ctx, f, i.a)); break;
            case OP_GLOBAL_LOAD:
                same(ctx, register_type(ctx, f, i.dst), global_type(ctx, p, i.a)); break;
            case OP_GLOBAL_STORE:
                same(ctx, global_type(ctx, p, i.dst), register_type(ctx, f, i.a)); break;
            case OP_BOUNDS:
                same(ctx, register_type(ctx, f, i.a), TY_INT);
                if (!i.c || i.c > L_MAX_ARRAY) invalid(ctx, "invalid array bounds limit");
                break;
            case OP_CLEAR:
                (void)slot_type(ctx, f, i.dst);
                if (!f->slot_lengths[i.dst]) invalid(ctx, "cannot clear a scalar slot");
                break;
            case OP_NEG: case OP_NOT:
                same(ctx, register_type(ctx, f, i.dst), i.op == OP_NEG ? TY_INT : TY_BOOL);
                same(ctx, register_type(ctx, f, i.a), f->registers[i.dst]); break;
            case OP_ADD: case OP_SUB: case OP_MUL: case OP_DIV: case OP_REM:
                same(ctx, register_type(ctx, f, i.dst), TY_INT);
                same(ctx, register_type(ctx, f, i.a), TY_INT); same(ctx, register_type(ctx, f, i.b), TY_INT); break;
            case OP_EQ: case OP_NE:
                same(ctx, register_type(ctx, f, i.dst), TY_BOOL);
                if (IS_STRUCT(register_type(ctx, f, i.a))) invalid(ctx, "struct equality is not supported");
                same(ctx, register_type(ctx, f, i.a), register_type(ctx, f, i.b)); break;
            case OP_LT: case OP_LE: case OP_GT: case OP_GE:
                same(ctx, register_type(ctx, f, i.dst), TY_BOOL);
                same(ctx, register_type(ctx, f, i.a), TY_INT); same(ctx, register_type(ctx, f, i.b), TY_INT); break;
            case OP_BRANCH: same(ctx, register_type(ctx, f, i.a), TY_BOOL); break;
            case OP_CALL: {
                if (i.a >= p->function_count) invalid(ctx, "unknown callee");
                const IrFunction *callee = &p->functions[i.a];
                if (i.c != callee->parameter_count || i.b > f->argument_count || i.c > f->argument_count - i.b)
                    invalid(ctx, "invalid call argument vector");
                if (callee->result == TY_VOID) {
                    if (i.dst != L_NONE) invalid(ctx, "void call defines a register");
                } else same(ctx, register_type(ctx, f, i.dst), callee->result);
                for (uint32_t j = 0; j < i.c; ++j)
                    same(ctx, register_type(ctx, f, f->arguments[i.b + j]), slot_type(ctx, callee, j));
                break;
            }
            case OP_RETURN:
                if (f->result == TY_VOID) {
                    if (i.a != L_NONE) invalid(ctx, "void return has a value");
                } else same(ctx, register_type(ctx, f, i.a), f->result);
                break;
            case OP_SWITCH: {
                Type selector = register_type(ctx, f, i.a);
                if (selector != TY_INT && selector != TY_BYTE && !IS_ENUM(selector)) invalid(ctx, "switch selector must be int, byte or enum");
                if (i.b > f->switch_count || i.c > f->switch_count - i.b) invalid(ctx, "invalid switch case vector");
                if (i.dst != L_NONE && i.dst >= f->code_count) invalid(ctx, "switch default target out of range");
                for (uint32_t j = i.b; j < i.b + i.c; ++j) {
                    if (selector == TY_BYTE && (uint32_t)f->switch_entries[j].value > 255) invalid(ctx, "invalid byte switch value");
                    enum_value(ctx, p, selector, (uint32_t)f->switch_entries[j].value);
                    for (uint32_t k = i.b; k < j; ++k)
                        if (f->switch_entries[k].value == f->switch_entries[j].value)
                            invalid(ctx, "duplicate switch case value");
                }
                break;
            }
            case OP_TRAP: break;
            default: break;
            }
            uint32_t next[L_MAX_CASES + 1]; (void)successors(ctx, f, pc, next);
        }
        bool *seen = NULL;
        dataflow(ctx, f, &seen);
        /* Definitions that live only on unreachable paths are rejected: SSA values must be well-defined everywhere. */
        bool *reachable_defined = allocate(ctx, f->register_count * sizeof(*reachable_defined));
        for (uint32_t pc = 0; pc < f->code_count; ++pc) {
            if (!seen[pc]) continue;
            Instruction i = f->code[pc];
            if (defines(i.op) && !(i.op == OP_CALL && i.dst == L_NONE)) reachable_defined[i.dst] = true;
        }
        for (uint32_t j = 0; j < f->register_count; ++j)
            if (!reachable_defined[j]) invalid(ctx, "SSA register has no definition");
        release(ctx, reachable_defined);
        release(ctx, seen);
        release(ctx, defined);
    }
    ctx->filename = saved;
}
