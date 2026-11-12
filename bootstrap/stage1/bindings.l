// First replacement-grammar file slice. Parses syntax; never runs input.
module l.compiler.bindings;

import l.compiler.lexer as lexer;
import l.compiler.expressions as expressions;
import l.compiler.headers as headers;

pub const int max_nodes = 1024;
pub const int max_functions = 256;
namespace kind {
    pub const int Invalid = 0;
    pub const int Module = 1;
    pub const int Constant = 2;
    pub const int Function = 3;
    pub const int Parameter = 4;
}
pub enum Error { None, Header, Expression, ExpectedName, ExpectedAssign,
                 ExpectedOpen, ExpectedClose, ExpectedColon, ExpectedArrow,
                 ExpectedSemicolon, MisplacedHeader, TooManyNodes, TooManyFunctions };
pub struct Diagnostic {
    Error kind;
    headers::Error header;
    expressions::Error expression;
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
    int name_start;
    int name_length;
    bool exported;
    int header;
    int type;
    int items;
    int body;
    int next;
};

static int kinds[max_nodes];
static int starts[max_nodes];
static int lengths[max_nodes];
static int lines[max_nodes];
static int columns[max_nodes];
static int name_starts[max_nodes];
static int name_lengths[max_nodes];
static bool exports[max_nodes];
static int header_ids[max_nodes];
static int types[max_nodes];
static int items[max_nodes];
static int bodies[max_nodes];
static int nexts[max_nodes];
static int used = 0;
static int function_count = 0;
static Error failure = Error::None;
static headers::Error header_failure = headers::Error::None;
static expressions::Error expression_failure = expressions::Error::None;
static lexer::Error lexical_failure = lexer::Error::None;
static int failure_start = 0;
static int failure_length = 0;
static int failure_line = 1;
static int failure_column = 1;

lexer::Token current() { return expressions::current(); }
void reject(Error error, lexer::Token at) {
    if (failure != Error::None) return;
    failure = error;
    failure_start = at.start;
    failure_length = at.length;
    failure_line = at.line;
    failure_column = at.column;
}
bool ok() {
    if (failure != Error::None) return false;
    expressions::Diagnostic error = expressions::diagnostic();
    if (error.kind != expressions::Error::None) {
        failure = Error::Expression;
        expression_failure = error.kind;
        lexical_failure = error.lexical;
        failure_start = error.start;
        failure_length = error.length;
        failure_line = error.line;
        failure_column = error.column;
    }
    return failure == Error::None;
}
bool take(lexer::Kind kind) {
    if (!ok()) return false;
    bool result = expressions::consume(kind);
    ok();
    return result;
}
void expect(lexer::Kind kind, Error error) {
    if (!take(kind) && ok()) reject(error, current());
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
    name_starts[id] = 0;
    name_lengths[id] = 0;
    exports[id] = false;
    header_ids[id] = -1;
    types[id] = -1;
    items[id] = -1;
    bodies[id] = -1;
    nexts[id] = -1;
    return id;
}
int type() {
    if (!ok()) return -1;
    int result = expressions::parse_type();
    ok();
    return result;
}
int value() {
    if (!ok()) return -1;
    int result = expressions::parse_next();
    ok();
    return result;
}
int parameter() {
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedName);
    expect(lexer::Kind::Colon, Error::ExpectedColon);
    int declared = type();
    int result = make_node(kind::Parameter, name);
    if (result != -1) {
        name_starts[result] = name.start;
        name_lengths[result] = name.length;
        types[result] = declared;
    }
    return result;
}
int declaration() {
    lexer::Token start = current();
    if (start.kind == lexer::Kind::Module || start.kind == lexer::Kind::Import) {
        reject(Error::MisplacedHeader, start);
        return -1;
    }
    bool exported = take(lexer::Kind::Pub);
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedName);
    int result = -1;
    if (take(lexer::Kind::Colon)) {
        int declared = type();
        expect(lexer::Kind::Assign, Error::ExpectedAssign);
        int initial = value();
        expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
        result = make_node(kind::Constant, start);
        if (result != -1) { types[result] = declared; bodies[result] = initial; }
    } else {
        expect(lexer::Kind::Assign, Error::ExpectedAssign);
        expect(lexer::Kind::LeftParen, Error::ExpectedOpen);
        if (ok() && function_count == max_functions) reject(Error::TooManyFunctions, start);
        if (!ok()) return -1;
        function_count++;
        result = make_node(kind::Function, start);
        int first = -1;
        int last = -1;
        if (!take(lexer::Kind::RightParen)) {
            while (ok()) {
                int item = parameter();
                if (!ok()) break;
                if (last == -1) first = item;
                else nexts[last] = item;
                last = item;
                if (!take(lexer::Kind::Comma)) break;
            }
            expect(lexer::Kind::RightParen, Error::ExpectedClose);
        }
        expect(lexer::Kind::Colon, Error::ExpectedColon);
        int declared = type();
        expect(lexer::Kind::Arrow, Error::ExpectedArrow);
        int body = value();
        expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
        if (!ok()) return -1;
        types[result] = declared;
        items[result] = first;
        bodies[result] = body;
    }
    if (result != -1) {
        name_starts[result] = name.start;
        name_lengths[result] = name.length;
        exports[result] = exported;
    }
    return result;
}
pub int parse() {
    used = 0;
    function_count = 0;
    failure = Error::None;
    header_failure = headers::Error::None;
    expression_failure = expressions::Error::None;
    lexical_failure = lexer::Error::None;
    failure_start = 0;
    failure_length = 0;
    failure_line = 1;
    failure_column = 1;
    int header = headers::parse_replacement_prefix();
    if (header == -1) {
        headers::Diagnostic error = headers::diagnostic();
        failure = Error::Header;
        header_failure = error.kind;
        lexical_failure = error.lexical;
        failure_start = error.start;
        failure_length = error.length;
        failure_line = error.line;
        failure_column = error.column;
        headers::discard();
        return -1;
    }
    headers::Node heading = headers::node(header);
    lexer::Token start = lexer::Token{lexer::Kind::Module, heading.start, heading.length,
        heading.line, heading.column, 0, 0, lexer::Error::None};
    int root = make_node(kind::Module, start);
    int last = -1;
    while (ok() && current().kind != lexer::Kind::End) {
        int item = declaration();
        if (!ok()) break;
        if (last == -1) items[root] = item;
        else nexts[last] = item;
        last = item;
    }
    if (!ok()) { used = 0; function_count = 0; headers::discard(); return -1; }
    header_ids[root] = header;
    return root;
}
pub int node_count() { return used; }
pub Node node(int id) {
    if (id < 0 || id >= used) return Node{kind::Invalid, 0, 0, 0, 0, 0, 0, false, -1, -1, -1, -1, -1};
    return Node{kinds[id], starts[id], lengths[id], lines[id], columns[id], name_starts[id], name_lengths[id],
        exports[id], header_ids[id], types[id], items[id], bodies[id], nexts[id]};
}
pub Diagnostic diagnostic() {
    return Diagnostic{failure, header_failure, expression_failure, lexical_failure,
        failure_start, failure_length, failure_line, failure_column};
}
pub string error_message(Error error) {
    switch (error) {
        case Error::None: return "no binding-file error";
        case Error::Header: return "module/import header error";
        case Error::Expression: return "expression error";
        case Error::ExpectedName: return "expected binding or parameter name";
        case Error::ExpectedAssign: return "expected '=' after binding name/type";
        case Error::ExpectedOpen: return "expected '(' after function binding '='";
        case Error::ExpectedClose: return "expected ')' after parameters";
        case Error::ExpectedColon: return "expected ':' before written type";
        case Error::ExpectedArrow: return "expected '=>' before function expression";
        case Error::ExpectedSemicolon: return "expected ';' after binding";
        case Error::MisplacedHeader: return "module and import declarations must precede bindings";
        case Error::TooManyNodes: return "binding file exceeds 1024 declaration nodes";
        case Error::TooManyFunctions: return "binding file exceeds 256 functions";
        default: return "unknown binding-file error";
    }
}
