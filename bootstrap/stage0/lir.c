#include "l.h"

#include <string.h>

typedef struct { Context *ctx; Program *program; IrFunction *fn; } Lower;
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
    case EX_INT: case EX_BOOL: return constant(l, e->token, e->type, (int32_t)e->integer);
    case EX_NAME:
        r = reg(l, e->type); emit(l, e->token, OP_LOAD, r, e->symbol, 0, 0); return r;
    case EX_INDEX: {
        uint32_t idx = lower_expr(l, e->right);
        emit(l, e->token, OP_BOUNDS, 0, idx, 0, e->length);
        r = reg(l, e->type);
        emit(l, e->token, OP_LOAD, r, e->symbol, idx, 1);
        return r;
    }
    case EX_ASSIGN:
        if (e->left->kind == EX_INDEX) {
            /* Left-to-right: the index is evaluated and bounds-checked before the stored value. */
            uint32_t idx = lower_expr(l, e->left->right);
            emit(l, e->token, OP_BOUNDS, 0, idx, 0, e->left->length);
            r = lower_expr(l, e->right);
            emit(l, e->token, OP_STORE, e->left->symbol, r, idx, 1);
            return r;
        }
        r = lower_expr(l, e->right); emit(l, e->token, OP_STORE, e->left->symbol, r, 0, 0); return r;
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
        emit(l, e->token, OP_STORE, e->left->symbol, r, 0, 0); return a;
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
    case EX_CALL: {
        /* Evaluate first: nested calls must not split an outer call's argument vector. */
        uint32_t values[L_MAX_SLOTS], count = 0;
        for (ExprList *arg = e->args; arg; arg = arg->next) values[count++] = lower_expr(l, arg->value);
        uint32_t start = l->fn->argument_count;
        if (count > L_MAX_ARGS - start) token_fail(l->ctx, e->token, "too many LIR call arguments");
        reserve(l->ctx, (void **)&l->fn->arguments, &l->fn->argument_capacity, start + count, sizeof(uint32_t));
        if (count) memcpy(l->fn->arguments + start, values, count * sizeof(uint32_t));
        l->fn->argument_count += count;
        r = e->type == TY_VOID ? L_NONE : reg(l, e->type);
        emit(l, e->token, OP_CALL, r, e->symbol, start, count); return r;
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
        if (lower_stmt(l, s->body)) {
            if (s->step) (void)lower_expr(l, s->step);
            emit(l, s->token, OP_JUMP, 0, start, 0, 0);
        }
        l->fn->code[branch].c = l->fn->code_count;
        break;
    }
    case ST_EMPTY: break;
    default: token_fail(l->ctx, s->token, "invalid AST statement during lowering");
    }
    return true;
}

Program *lower(Context *ctx, Ast *ast) {
    Program *p = allocate(ctx, sizeof(*p));
    p->function_count = ast->function_count;
    p->functions = allocate(ctx, p->function_count * sizeof(*p->functions));
    uint32_t index = 0;
    for (Function *fn = ast->functions; fn; fn = fn->next, ++index) {
        IrFunction *f = &p->functions[index];
        f->name = copy_text(ctx, fn->name.text, fn->name.length);
        f->result = fn->result; f->parameter_count = fn->parameter_count; f->slot_count = fn->slot_count;
        f->slots = allocate(ctx, L_MAX_SLOTS * sizeof(*f->slots));
        f->slot_lengths = allocate(ctx, L_MAX_SLOTS * sizeof(*f->slot_lengths));
        memcpy(f->slots, fn->slots, fn->slot_count * sizeof(*f->slots));
        memcpy(f->slot_lengths, fn->lengths, fn->slot_count * sizeof(*f->slot_lengths));
        if (!strcmp(f->name, "main")) p->entry = index;
        Lower l = { ctx, p, f };
        if (lower_stmt(&l, fn->body)) emit(&l, fn->name, OP_RETURN, 0, L_NONE, 0, 0);
    }
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
static void same(Context *ctx, Type a, Type b) {
    if (a != b) invalid(ctx, "operand type mismatch");
}
static void access_mode(Context *ctx, const IrFunction *f, uint32_t slot, Instruction i) {
    (void)slot_type(ctx, f, slot);
    if (i.c > 1) invalid(ctx, "invalid addressing mode");
    if ((f->slot_lengths[slot] != 0) != (i.c == 1)) invalid(ctx, "slot shape does not match addressing mode");
    if (i.c) same(ctx, register_type(ctx, f, i.b), TY_INT);
}
static bool defines(Opcode op) { return op <= OP_LOAD || (op >= OP_ADD && op <= OP_GE) || op == OP_CALL; }
static unsigned successors(Context *ctx, const IrFunction *f, uint32_t pc, uint32_t next[2]) {
    Instruction i = f->code[pc];
    unsigned count;
    if (i.op == OP_RETURN) return 0;
    if (i.op == OP_JUMP) { next[0] = i.a; count = 1; }
    else if (i.op == OP_BRANCH) { next[0] = i.b; next[1] = i.c; count = 2; }
    else { next[0] = pc + 1; count = 1; }
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
        uint32_t next[2]; unsigned count = successors(ctx, f, pc, next);
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
        case OP_NEG: case OP_NOT: case OP_BRANCH: use(ctx, bits, i.a); break;
        case OP_ADD: case OP_SUB: case OP_MUL: case OP_DIV: case OP_REM:
        case OP_EQ: case OP_NE: case OP_LT: case OP_LE: case OP_GT: case OP_GE:
            use(ctx, bits, i.a); use(ctx, bits, i.b); break;
        case OP_CALL:
            for (uint32_t j = 0; j < i.c; ++j) use(ctx, bits, f->arguments[i.b + j]);
            break;
        case OP_RETURN: if (i.a != L_NONE) use(ctx, bits, i.a); break;
        case OP_BOUNDS: use(ctx, bits, i.a); break;
        default: break;
        }
    }
    release(ctx, queue); release(ctx, queued); release(ctx, out); release(ctx, state);
    *seen_out = seen;
}

void verify(Context *ctx, const Program *p) {
    if (!p->function_count || p->function_count > L_MAX_FUNCTIONS || p->entry >= p->function_count)
        invalid(ctx, "invalid function table");
    const IrFunction *entry = &p->functions[p->entry];
    if (entry->result != TY_INT || entry->parameter_count) invalid(ctx, "invalid entry signature");
    for (uint32_t n = 0; n < p->function_count; ++n) {
        const IrFunction *f = &p->functions[n];
        if (f->result > TY_BOOL || f->parameter_count > f->slot_count || f->slot_count > L_MAX_SLOTS ||
            f->register_count > L_MAX_REGISTERS || !f->code_count || f->code_count > L_MAX_CODE ||
            f->argument_count > L_MAX_ARGS) invalid(ctx, "invalid function limits or result type");
        for (uint32_t j = 0; j < f->slot_count; ++j)
            if (f->slots[j] != TY_INT && f->slots[j] != TY_BOOL) invalid(ctx, "invalid slot type");
        uint32_t elements = 0;
        for (uint32_t j = 0; j < f->slot_count; ++j) {
            if (f->slot_lengths[j] > L_MAX_ARRAY) invalid(ctx, "array length out of range");
            if (j < f->parameter_count && f->slot_lengths[j]) invalid(ctx, "array parameters are not supported");
            if (elements > L_MAX_SLOTS_ELEMENTS - f->slot_lengths[j])
                invalid(ctx, "too many array elements");
            elements += f->slot_lengths[j];
        }
        for (uint32_t j = 0; j < f->register_count; ++j)
            if (f->registers[j] != TY_INT && f->registers[j] != TY_BOOL) invalid(ctx, "invalid register type");
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
                if (f->registers[i.dst] == TY_BOOL && i.a > 1) invalid(ctx, "invalid bool constant");
                break;
            case OP_LOAD:
                access_mode(ctx, f, i.a, i);
                same(ctx, register_type(ctx, f, i.dst), slot_type(ctx, f, i.a)); break;
            case OP_STORE:
                access_mode(ctx, f, i.dst, i);
                same(ctx, slot_type(ctx, f, i.dst), register_type(ctx, f, i.a)); break;
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
            default: break;
            }
            uint32_t next[2]; (void)successors(ctx, f, pc, next);
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
}
