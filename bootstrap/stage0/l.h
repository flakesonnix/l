#ifndef L_STAGE0_H
#define L_STAGE0_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <setjmp.h>

#define L_IR_MAJOR 1
#define L_IR_MINOR 0
#define L_BC_MAJOR 1
#define L_BC_MINOR 0
#define L_NONE UINT32_MAX
#define L_MAX_FUNCTIONS 256u
#define L_MAX_REGISTERS 4096u
#define L_MAX_SLOTS 1024u
#define L_MAX_CODE 16384u
#define L_MAX_ARGS 2048u
#define L_MAX_DEPTH 256u
#define L_MAX_STEPS UINT64_C(10000000)

typedef struct Allocation Allocation;
typedef struct {
    const char *filename;
    jmp_buf failure;
    Allocation *allocations;
    size_t allocated;
    int status;
    unsigned nesting;
} Context;

typedef struct { const char *text; size_t length; uint32_t line, column; int kind; int64_t integer; } Token;
typedef enum { TY_VOID, TY_INT, TY_BOOL, TY_AUTO } Type;
enum {
    TK_EOF = 256, TK_NAME, TK_INTEGER, TK_INT, TK_BOOL, TK_VOID, TK_AUTO,
    TK_CONST, TK_TRUE, TK_FALSE, TK_IF, TK_ELSE, TK_WHILE, TK_FOR, TK_RETURN,
    TK_MODULE, TK_EQ, TK_NE, TK_LE, TK_GE, TK_AND, TK_OR, TK_INC, TK_DEC
};

typedef struct Expr Expr;
typedef struct Stmt Stmt;
typedef struct Decl Decl;
typedef struct Function Function;
typedef struct ExprList ExprList;
struct ExprList { Expr *value; ExprList *next; };
typedef enum { EX_INT, EX_BOOL, EX_NAME, EX_UNARY, EX_BINARY, EX_ASSIGN, EX_CALL, EX_POSTFIX } ExprKind;
struct Expr {
    ExprKind kind;
    Token token;
    Type type;
    int op;
    uint32_t symbol;
    int64_t integer;
    Expr *left, *right;
    ExprList *args;
};
struct Decl { Token name; Type type; bool immutable; uint32_t slot; Expr *value; Decl *next; };
typedef enum { ST_BLOCK, ST_DECL, ST_EXPR, ST_IF, ST_WHILE, ST_FOR, ST_RETURN, ST_EMPTY } StmtKind;
struct Stmt {
    StmtKind kind;
    Token token;
    Stmt *next, *body, *other, *init;
    Expr *expr, *condition, *step;
    Decl *decl;
};
struct Function {
    Token name;
    Type result;
    Decl *parameters;
    uint32_t parameter_count, slot_count;
    Type slots[L_MAX_SLOTS];
    Stmt *body;
    Function *next;
};
typedef struct { Function *functions; uint32_t function_count; } Ast;

typedef enum {
    OP_CONST, OP_LOAD, OP_STORE, OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_REM,
    OP_NEG, OP_NOT, OP_EQ, OP_NE, OP_LT, OP_LE, OP_GT, OP_GE,
    OP_JUMP, OP_BRANCH, OP_CALL, OP_RETURN, OP_COUNT
} Opcode;
typedef struct { Opcode op; uint32_t dst, a, b, c, line, column; } Instruction;
typedef struct {
    char *name;
    Type result;
    uint32_t parameter_count, slot_count, register_count, code_count, argument_count;
    Type *slots, *registers;
    Instruction *code;
    uint32_t *arguments;
    size_t register_capacity, code_capacity, argument_capacity;
} IrFunction;
typedef struct { uint32_t function_count, entry; IrFunction *functions; } Program;

_Noreturn void fail(Context *, uint32_t, uint32_t, const char *, ...);
_Noreturn void token_fail(Context *, Token, const char *);
void *allocate(Context *, size_t);
void release(Context *, void *);
void cleanup(Context *);
void reserve(Context *, void **, size_t *, size_t, size_t);
char *copy_text(Context *, const char *, size_t);
bool token_equal(Token, Token);
const char *type_name(Type);
void enter(Context *, Token);
void leave(Context *);
unsigned char *read_file(Context *, const char *, size_t *);
Token *lex(Context *, const char *, size_t, size_t *);
Ast *parse(Context *, Token *, size_t);
void analyze(Context *, Ast *);
Program *lower(Context *, Ast *);
void verify(Context *, const Program *);
void write_bytecode(Context *, const Program *, const char *);
Program *read_bytecode(Context *, const unsigned char *, size_t);
void inspect(const Program *, FILE *);
int32_t execute_program(Context *, const Program *);
int l_main(int, char **);

#endif
