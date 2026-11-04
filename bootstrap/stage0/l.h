#ifndef L_STAGE0_H
#define L_STAGE0_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <setjmp.h>

#define L_IR_MAJOR 1
#define L_IR_MINOR 3
#define L_BC_MAJOR 1
#define L_BC_MINOR 3
#define L_NONE UINT32_MAX
#define L_MAX_FUNCTIONS 256u
#define L_MAX_MODULES 256u
#define L_MAX_IMPORTS 1024u
#define L_MAX_CONSTANTS 1024u
#define L_MAX_GLOBALS 1024u
#define L_MAX_ALIASES 1024u
#define L_MAX_REGISTERS 4096u
#define L_MAX_SLOTS 1024u
#define L_MAX_ARRAY 65535u
#define L_MAX_SLOTS_ELEMENTS 65536u
#define L_MAX_CODE 16384u
#define L_MAX_CASES 1024u
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
typedef enum { TY_VOID, TY_INT, TY_BOOL, TY_AUTO, TY_NAMED } Type;
enum {
    TK_EOF = 256, TK_NAME, TK_INTEGER, TK_INT, TK_BOOL, TK_VOID, TK_AUTO,
    TK_CONST, TK_TRUE, TK_FALSE, TK_IF, TK_ELSE, TK_WHILE, TK_FOR, TK_RETURN,
    TK_MODULE, TK_EQ, TK_NE, TK_LE, TK_GE, TK_AND, TK_OR, TK_INC, TK_DEC,
    TK_BREAK, TK_CONTINUE, TK_SWITCH, TK_CASE, TK_DEFAULT,
    TK_IMPORT, TK_AS, TK_PUB, TK_NAMESPACE, TK_SCOPE, TK_STATIC, TK_USING
};

typedef struct Expr Expr;
typedef struct Stmt Stmt;
typedef struct Decl Decl;
typedef struct Function Function;
typedef struct ExprList ExprList;
typedef struct SwitchCase SwitchCase;
typedef struct Module Module;
typedef struct Import Import;
typedef struct ImportName ImportName;
typedef struct Namespace Namespace;
typedef struct Global Global;
typedef struct TypeAlias TypeAlias;
struct ExprList { Expr *value; ExprList *next; };
struct SwitchCase { Token token; int32_t value; bool is_default; Stmt *body; SwitchCase *next; };
typedef enum { EX_INT, EX_BOOL, EX_NAME, EX_UNARY, EX_BINARY, EX_ASSIGN, EX_CALL, EX_POSTFIX, EX_INDEX, EX_GLOBAL } ExprKind;
struct Expr {
    ExprKind kind;
    Token token;
    Type type;
    int op;
    uint32_t symbol;
    uint32_t length;
    int64_t integer;
    Expr *left, *right;
    ExprList *args;
    Global *global;
};
struct Decl { Token name, type_name; Type type; bool immutable; uint32_t slot; uint32_t array; Expr *value; Decl *next; };
typedef enum { ST_BLOCK, ST_DECL, ST_EXPR, ST_IF, ST_WHILE, ST_FOR, ST_RETURN, ST_EMPTY, ST_BREAK, ST_CONTINUE, ST_SWITCH } StmtKind;
struct Stmt {
    StmtKind kind;
    Token token;
    Stmt *next, *body, *other, *init;
    Expr *expr, *condition, *step;
    Decl *decl;
    SwitchCase *cases;
};
struct Function {
    Token name;
    Token scope, result_name;
    Module *module;
    bool exported;
    Type result;
    Decl *parameters;
    uint32_t parameter_count, slot_count;
    Type slots[L_MAX_SLOTS];
    uint32_t lengths[L_MAX_SLOTS];
    Stmt *body;
    Function *next;
};
struct Global {
    Token name, scope, type_name;
    Module *module;
    Type type;
    bool exported, is_static;
    Expr *value;
    int32_t integer;
    unsigned state;
    uint32_t symbol;
    Global *parent, *next;
};
struct TypeAlias {
    Token name, scope, target_name;
    Module *module;
    Type type;
    bool exported;
    unsigned state;
    TypeAlias *parent, *next;
};
struct ImportName { Token name, binding; ImportName *next; };
struct Import { Token name, qualifier, alias; ImportName *names; Module *target; Import *next; };
struct Namespace { Token name; Namespace *next; };
struct Module {
    Token name, qualifier;
    const char *path, *package;
    Import *imports;
    Namespace *namespaces;
    Function *functions;
    Global *globals;
    TypeAlias *aliases;
    unsigned state;
    Module *next;
};
typedef struct {
    Function *functions;
    uint32_t function_count, constant_count, static_count, alias_count;
    Module *modules, *entry;
    Function *entrypoint;
    Global *globals;
    TypeAlias *aliases;
} Ast;
typedef struct ModuleRoot ModuleRoot;
typedef struct PackageDependency PackageDependency;
struct ModuleRoot { char *package, *directory; Token prefix; ModuleRoot *next; };
struct PackageDependency { char *from, *to; PackageDependency *next; };
typedef struct { char *package; ModuleRoot *roots; PackageDependency *dependencies; } ModuleConfig;

typedef enum {
    OP_CONST, OP_LOAD, OP_STORE, OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_REM,
    OP_NEG, OP_NOT, OP_EQ, OP_NE, OP_LT, OP_LE, OP_GT, OP_GE,
    OP_JUMP, OP_BRANCH, OP_CALL, OP_RETURN, OP_BOUNDS, OP_CLEAR, OP_SWITCH, OP_TRAP,
    OP_GLOBAL_LOAD, OP_GLOBAL_STORE, OP_COUNT
} Opcode;
typedef struct { Opcode op; uint32_t dst, a, b, c, line, column; } Instruction;
typedef struct { int32_t value; uint32_t target; } SwitchEntry;
typedef struct {
    char *name;
    const char *source_path; /* Source-only diagnostics; not serialized. */
    Type result;
    uint32_t parameter_count, slot_count, register_count, code_count, argument_count, switch_count;
    Type *slots, *registers;
    uint32_t *slot_lengths;
    Instruction *code;
    uint32_t *arguments;
    SwitchEntry *switch_entries;
    size_t register_capacity, code_capacity, argument_capacity, switch_capacity;
} IrFunction;
typedef struct { char *name; Type type; int32_t initial; } IrGlobal;
typedef struct {
    uint32_t function_count, entry;
    IrFunction *functions;
    uint32_t global_count;
    IrGlobal *globals;
} Program;

_Noreturn void fail(Context *, uint32_t, uint32_t, const char *, ...);
_Noreturn void token_fail(Context *, Token, const char *);
void *allocate(Context *, size_t);
void release(Context *, void *);
void cleanup(Context *);
void reserve(Context *, void **, size_t *, size_t, size_t);
char *copy_text(Context *, const char *, size_t);
bool token_equal(Token, Token);
Token join_name(Context *, Token, Token, const char *);
Token namespace_path(Context *, Token);
Token leaf_name(Token);
Token parent_scope(Token);
const char *type_name(Type);
void enter(Context *, Token);
void leave(Context *);
unsigned char *read_file(Context *, const char *, size_t *);
Token *lex(Context *, const char *, size_t, size_t *);
Ast *parse(Context *, Token *, size_t);
ModuleConfig *read_manifest(Context *, const char *);
char *canonical_path(Context *, const char *);
char *relative_path(Context *, const char *, const char *);
char *source_directory(Context *, const char *);
Ast *load_modules(Context *, const ModuleConfig *, const char *, const unsigned char *, size_t);
void analyze(Context *, Ast *);
void evaluate_constants(Context *, Ast *);
Program *lower(Context *, Ast *);
void verify(Context *, const Program *);
void write_bytecode(Context *, const Program *, const char *);
Program *read_bytecode(Context *, const unsigned char *, size_t);
void inspect(const Program *, FILE *);
int32_t execute_program(Context *, const Program *);
int l_main(int, char **);

#endif
