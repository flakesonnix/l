// Module/import header syntax only; no source loading, binding or resolution.
module l.compiler.headers;

import l.compiler.lexer as lexer;
import l.compiler.expressions as expressions;

pub const int max_nodes = 2048;
namespace kind {
    pub const int Invalid = 0;
    pub const int Module = 1;
    pub const int Import = 2;
    pub const int Selection = 3;
    pub const int Name = 4;
}
pub enum Error { None, Lexical, ExpectedModule, ExpectedName, ExpectedSemicolon,
                 ExpectedSelection, ExpectedClose, DuplicateModule, TrailingInput, TooManyNodes };
pub struct Diagnostic {
    Error kind;
    lexer::Error lexical;
    int start;
    int length;
    int line;
    int column;
};
pub struct Node {
    int kind;
    int start;
    int length;
    int line;
    int column;
    int path;
    int alias;
    int items;
    int next;
};

static int kinds[max_nodes];
static int starts[max_nodes];
static int lengths[max_nodes];
static int lines[max_nodes];
static int columns[max_nodes];
static int paths[max_nodes];
static int aliases[max_nodes];
static int items[max_nodes];
static int nexts[max_nodes];
static int used = 0;
static Error failure = Error::None;
static lexer::Error lexical_failure = lexer::Error::None;
static int failure_start = 0;
static int failure_length = 0;
static int failure_line = 1;
static int failure_column = 1;

void reject(Error error, lexer::Token at) {
    if (failure != Error::None) return;
    failure = error;
    failure_start = at.start;
    failure_length = at.length;
    failure_line = at.line;
    failure_column = at.column;
}
bool ok() {
    if (failure == Error::None) {
        expressions::Diagnostic error = expressions::diagnostic();
        if (error.kind != expressions::Error::None) {
            failure = Error::Lexical;
            lexical_failure = error.lexical;
            failure_start = error.start;
            failure_length = error.length;
            failure_line = error.line;
            failure_column = error.column;
        }
    }
    return failure == Error::None;
}
lexer::Token current() { return expressions::current(); }
bool take(lexer::Kind expected) {
    if (!ok()) return false;
    bool result = expressions::consume(expected);
    ok();
    return result;
}
void expect(lexer::Kind expected, Error error) {
    if (!take(expected) && ok()) reject(error, current());
}
int make_node(int kind, lexer::Token at) {
    if (!ok()) return -1;
    if (used == max_nodes) { reject(Error::TooManyNodes, at); return -1; }
    int id = used++;
    kinds[id] = kind;
    starts[id] = at.start;
    lengths[id] = at.length;
    lines[id] = at.line;
    columns[id] = at.column;
    paths[id] = -1;
    aliases[id] = -1;
    items[id] = -1;
    nexts[id] = -1;
    return id;
}
int name() {
    lexer::Token at = current();
    expect(lexer::Kind::Name, Error::ExpectedName);
    return make_node(kind::Name, at);
}
int path(lexer::Kind separator) {
    int first = name();
    int last = first;
    while (take(separator)) {
        int part = name();
        if (!ok()) break;
        nexts[last] = part;
        last = part;
    }
    return first;
}
int import_item(lexer::Token at) {
    int result = make_node(kind::Import, at);
    int target = path(lexer::Kind::Dot);
    int alias = -1;
    int first = -1;
    if (take(lexer::Kind::As)) alias = name();
    else if (take(lexer::Kind::Scope)) {
        expect(lexer::Kind::LeftBrace, Error::ExpectedSelection);
        int last = -1;
        while (ok()) {
            lexer::Token start = current();
            int selected = path(lexer::Kind::Scope);
            int binding = -1;
            if (take(lexer::Kind::As)) binding = name();
            int item = make_node(kind::Selection, start);
            if (!ok()) break;
            paths[item] = selected;
            aliases[item] = binding;
            if (last == -1) first = item;
            else nexts[last] = item;
            last = item;
            if (!take(lexer::Kind::Comma)) break;
            if (current().kind == lexer::Kind::RightBrace) break;
        }
        expect(lexer::Kind::RightBrace, Error::ExpectedClose);
    }
    expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
    if (!ok()) return -1;
    paths[result] = target;
    aliases[result] = alias;
    items[result] = first;
    return result;
}
pub void discard() { used = 0; expressions::discard(); }

// Replay the loaded source, leaving the first body token on the shared cursor.
pub int parse_prefix() {
    used = 0;
    failure = Error::None;
    lexical_failure = lexer::Error::None;
    failure_start = 0;
    failure_length = 0;
    failure_line = 1;
    failure_column = 1;
    expressions::begin();
    lexer::Token start = current();
    expect(lexer::Kind::Module, Error::ExpectedModule);
    int root = make_node(kind::Module, start);
    int module_path = path(lexer::Kind::Dot);
    expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
    int last = -1;
    while (ok() && current().kind == lexer::Kind::Import) {
        lexer::Token at = current();
        take(lexer::Kind::Import);
        int item = import_item(at);
        if (!ok()) break;
        if (last == -1) items[root] = item;
        else nexts[last] = item;
        last = item;
    }
    if (ok() && current().kind == lexer::Kind::Module) reject(Error::DuplicateModule, current());
    if (!ok()) { discard(); return -1; }
    paths[root] = module_path;
    return root;
}
// Standalone header-only syntax check, not a full source-file parser.
pub int parse() {
    int root = parse_prefix();
    if (ok() && current().kind != lexer::Kind::End) reject(Error::TrailingInput, current());
    if (!ok()) { discard(); return -1; }
    return root;
}
pub int node_count() { return used; }
pub Node node(int id) {
    if (id < 0 || id >= used) return Node{kind::Invalid, 0, 0, 0, 0, -1, -1, -1, -1};
    return Node{kinds[id], starts[id], lengths[id], lines[id], columns[id], paths[id], aliases[id], items[id], nexts[id]};
}
pub Diagnostic diagnostic() {
    return Diagnostic{failure, lexical_failure, failure_start, failure_length, failure_line, failure_column};
}
pub string error_message(Error error) {
    switch (error) {
        case Error::None: return "no header error";
        case Error::Lexical: return "lexical error";
        case Error::ExpectedModule: return "source must begin with a module declaration";
        case Error::ExpectedName: return "expected identifier";
        case Error::ExpectedSemicolon: return "expected ';' after module/import declaration";
        case Error::ExpectedSelection: return "selective imports require '{'; wildcard imports are not supported";
        case Error::ExpectedClose: return "expected '}' after selective imports";
        case Error::DuplicateModule: return "module declaration must not repeat";
        case Error::TrailingInput: return "unexpected token after module/import header";
        case Error::TooManyNodes: return "header exceeds 2048 AST nodes";
        default: return "unknown header error";
    }
}
