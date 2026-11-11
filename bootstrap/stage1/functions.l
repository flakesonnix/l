// File declaration syntax; no semantic checks, input storage or struct/enum bodies.
module l.compiler.functions;

import l.compiler.lexer as lexer;
import l.compiler.expressions as expressions;
import l.compiler.statements as statements;
import l.compiler.headers as headers;

pub const int max_nodes = 1024;
pub const int max_functions = 256;
namespace kind {
    pub const int Invalid = 0;
    pub const int Module = 1;
    pub const int Function = 2;
    pub const int Parameter = 3;
    pub const int Namespace = 4;
    pub const int Alias = 5;
    pub const int Constant = 6;
    pub const int Static = 7;
}
pub enum Error { None, Header, Statement, Expression, ExpectedType, ExpectedName,
                 ExpectedOpen, ExpectedClose, ExpectedBody, ExpectedSemicolon,
                 ArrayParameter, MisplacedHeader, TooManyNodes, TooManyFunctions,
                 NamespaceVisibility, ExpectedNamespaceOpen, ExpectedNamespaceClose, TooDeep,
                 ExpectedNamespaceName, ExpectedAliasName, ExpectedAliasAssign, ExpectedAliasSemicolon,
                 ExpectedGlobalName, ExpectedGlobalInitializer, ExpectedGlobalSemicolon,
                 ExpectedArrayClose, ArrayInitializer };
pub struct Diagnostic {
    Error kind;
    headers::Error header;
    statements::Error statement;
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
    int declared_type;
    int type_name;
    int name_start;
    int name_length;
    bool exported;
    bool external;
    bool immutable;
    int header;
    int items;
    int body;
    int next;
    int expression;
    int array;
};
struct Type { int kind; int name; };

static int kinds[max_nodes];
static int starts[max_nodes];
static int lengths[max_nodes];
static int lines[max_nodes];
static int columns[max_nodes];
static int declared_types[max_nodes];
static int type_names[max_nodes];
static int name_starts[max_nodes];
static int name_lengths[max_nodes];
static bool exports[max_nodes];
static bool externals[max_nodes];
static bool immutables[max_nodes];
static int header_ids[max_nodes];
static int items[max_nodes];
static int bodies[max_nodes];
static int nexts[max_nodes];
static int initializers[max_nodes];
static int arrays[max_nodes];
static int used = 0;
static int function_count = 0;
static Error failure = Error::None;
static headers::Error header_failure = headers::Error::None;
static statements::Error statement_failure = statements::Error::None;
static expressions::Error expression_failure = expressions::Error::None;
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
    if (failure != Error::None) return false;
    statements::Diagnostic statement = statements::diagnostic();
    if (statement.kind != statements::Error::None) {
        failure = Error::Statement;
        statement_failure = statement.kind;
        expression_failure = statement.expression;
        lexical_failure = statement.lexical;
        failure_start = statement.start;
        failure_length = statement.length;
        failure_line = statement.line;
        failure_column = statement.column;
    } else {
        expressions::Diagnostic expression = expressions::diagnostic();
        if (expression.kind != expressions::Error::None) {
            failure = Error::Expression;
            if (expression.kind == expressions::Error::TooDeep) failure = Error::TooDeep;
            expression_failure = expression.kind;
            lexical_failure = expression.lexical;
            failure_start = expression.start;
            failure_length = expression.length;
            failure_line = expression.line;
            failure_column = expression.column;
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
    declared_types[id] = statements::type_kind::Invalid;
    type_names[id] = -1;
    name_starts[id] = 0;
    name_lengths[id] = 0;
    exports[id] = false;
    externals[id] = false;
    immutables[id] = false;
    header_ids[id] = -1;
    items[id] = -1;
    bodies[id] = -1;
    nexts[id] = -1;
    initializers[id] = -1;
    arrays[id] = -1;
    return id;
}
Type type() {
    lexer::Token at = current();
    int primitive = statements::primitive(at.kind);
    if (primitive != statements::type_kind::Invalid) {
        take(at.kind);
        return Type{primitive, -1};
    }
    if (at.kind == lexer::Kind::Name) {
        int name = expressions::parse_name();
        ok();
        return Type{statements::type_kind::Named, name};
    }
    if (ok()) reject(Error::ExpectedType, at);
    return Type{statements::type_kind::Invalid, -1};
}
int parameter() {
    lexer::Token start = current();
    bool immutable = take(lexer::Kind::Const);
    Type declared = type();
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedName);
    if (ok() && current().kind == lexer::Kind::LeftBracket) reject(Error::ArrayParameter, current());
    int result = make_node(kind::Parameter, start);
    if (result != -1) {
        declared_types[result] = declared.kind;
        type_names[result] = declared.name;
        name_starts[result] = name.start;
        name_lengths[result] = name.length;
        immutables[result] = immutable;
    }
    return result;
}
int function(lexer::Token start, bool exported) {
    if (!ok()) return -1;
    if (function_count == max_functions) { reject(Error::TooManyFunctions, start); return -1; }
    function_count++;
    bool external = take(lexer::Kind::Extern);
    Type result_type = type();
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedName);
    expect(lexer::Kind::LeftParen, Error::ExpectedOpen);
    int result = make_node(kind::Function, start);
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
    int body = -1;
    if (external) expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
    else if (ok()) {
        if (current().kind != lexer::Kind::LeftBrace) reject(Error::ExpectedBody, current());
        else { body = statements::parse_next(); ok(); }
    }
    if (!ok()) return -1;
    declared_types[result] = result_type.kind;
    type_names[result] = result_type.name;
    name_starts[result] = name.start;
    name_lengths[result] = name.length;
    exports[result] = exported;
    externals[result] = external;
    items[result] = first;
    bodies[result] = body;
    return result;
}
int namespace_declaration() {
    lexer::Token start = current();
    if (!expressions::enter()) { ok(); return -1; }
    take(lexer::Kind::Namespace);
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedNamespaceName);
    expect(lexer::Kind::LeftBrace, Error::ExpectedNamespaceOpen);
    int result = make_node(kind::Namespace, start);
    int last = -1;
    while (ok() && !take(lexer::Kind::RightBrace)) {
        if (current().kind == lexer::Kind::End) { reject(Error::ExpectedNamespaceClose, current()); break; }
        int item = declaration();
        if (!ok()) break;
        if (last == -1) items[result] = item;
        else nexts[last] = item;
        last = item;
    }
    expressions::leave();
    if (!ok()) return -1;
    name_starts[result] = name.start;
    name_lengths[result] = name.length;
    return result;
}
int alias_declaration(lexer::Token start, bool exported) {
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedAliasName);
    expect(lexer::Kind::Assign, Error::ExpectedAliasAssign);
    Type target = type();
    expect(lexer::Kind::Semicolon, Error::ExpectedAliasSemicolon);
    int result = make_node(kind::Alias, start);
    if (result != -1) {
        declared_types[result] = target.kind;
        type_names[result] = target.name;
        name_starts[result] = name.start;
        name_lengths[result] = name.length;
        exports[result] = exported;
    }
    return result;
}
int value() {
    if (!ok()) return -1;
    int result = expressions::parse_next();
    ok();
    return result;
}
int global_declaration(lexer::Token start, bool exported, bool is_static) {
    Type declared = type();
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedGlobalName);
    int length = -1;
    int initial = -1;
    if (is_static && take(lexer::Kind::LeftBracket)) {
        length = value();
        expect(lexer::Kind::RightBracket, Error::ExpectedArrayClose);
        if (ok() && current().kind == lexer::Kind::Assign) reject(Error::ArrayInitializer, current());
    } else {
        expect(lexer::Kind::Assign, Error::ExpectedGlobalInitializer);
        initial = value();
    }
    expect(lexer::Kind::Semicolon, Error::ExpectedGlobalSemicolon);
    int tag = kind::Constant;
    if (is_static) tag = kind::Static;
    int result = make_node(tag, start);
    if (result != -1) {
        declared_types[result] = declared.kind;
        type_names[result] = declared.name;
        name_starts[result] = name.start;
        name_lengths[result] = name.length;
        exports[result] = exported;
        immutables[result] = !is_static;
        initializers[result] = initial;
        arrays[result] = length;
    }
    return result;
}
int declaration() {
    if (!ok()) return -1;
    lexer::Token start = current();
    bool exported = take(lexer::Kind::Pub);
    if (ok() && current().kind == lexer::Kind::Namespace) {
        if (exported) { reject(Error::NamespaceVisibility, start); return -1; }
        return namespace_declaration();
    }
    if (take(lexer::Kind::Using)) return alias_declaration(start, exported);
    bool is_static = take(lexer::Kind::Static);
    if (is_static || take(lexer::Kind::Const)) return global_declaration(start, exported, is_static);
    if (ok() && (current().kind == lexer::Kind::Module || current().kind == lexer::Kind::Import)) {
        reject(Error::MisplacedHeader, current());
    }
    return function(start, exported);
}
void discard() {
    used = 0;
    function_count = 0;
    headers::discard();
    statements::discard();
}
pub int parse() {
    used = 0;
    function_count = 0;
    failure = Error::None;
    header_failure = headers::Error::None;
    statement_failure = statements::Error::None;
    expression_failure = expressions::Error::None;
    lexical_failure = lexer::Error::None;
    failure_start = 0;
    failure_length = 0;
    failure_line = 1;
    failure_column = 1;
    statements::begin();
    int header = headers::parse_prefix();
    if (header == -1) {
        headers::Diagnostic error = headers::diagnostic();
        failure = Error::Header;
        header_failure = error.kind;
        lexical_failure = error.lexical;
        failure_start = error.start;
        failure_length = error.length;
        failure_line = error.line;
        failure_column = error.column;
        discard();
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
    if (!ok()) { discard(); return -1; }
    header_ids[root] = header;
    return root;
}
pub int node_count() { return used; }
pub Node node(int id) {
    if (id < 0 || id >= used) return Node{kind::Invalid, 0, 0, 0, 0,
        statements::type_kind::Invalid, -1, 0, 0, false, false, false, -1, -1, -1, -1, -1, -1};
    return Node{kinds[id], starts[id], lengths[id], lines[id], columns[id], declared_types[id], type_names[id],
        name_starts[id], name_lengths[id], exports[id], externals[id], immutables[id], header_ids[id], items[id], bodies[id], nexts[id], initializers[id], arrays[id]};
}
pub Diagnostic diagnostic() {
    return Diagnostic{failure, header_failure, statement_failure, expression_failure, lexical_failure,
        failure_start, failure_length, failure_line, failure_column};
}
pub string error_message(Error error) {
    switch (error) {
        case Error::None: return "no function-file error";
        case Error::Header: return "module/import header error";
        case Error::Statement: return "function body error";
        case Error::Expression: return "expression error";
        case Error::ExpectedType: return "expected primitive or qualified type";
        case Error::ExpectedName: return "expected function or parameter name";
        case Error::ExpectedOpen: return "expected '(' after function name";
        case Error::ExpectedClose: return "expected ')' after parameters";
        case Error::ExpectedBody: return "expected function body";
        case Error::ExpectedSemicolon: return "expected ';' after extern declaration";
        case Error::ArrayParameter: return "arrays are not supported as parameters";
        case Error::MisplacedHeader: return "module and import declarations must precede other declarations";
        case Error::TooManyNodes: return "function file exceeds 1024 AST nodes";
        case Error::TooManyFunctions: return "function file exceeds 256 functions";
        case Error::NamespaceVisibility: return "namespaces do not change declaration visibility";
        case Error::ExpectedNamespaceOpen: return "expected '{' after namespace name";
        case Error::ExpectedNamespaceClose: return "expected '}' after namespace";
        case Error::TooDeep: return "syntax nesting exceeds 48";
        case Error::ExpectedNamespaceName: return "expected namespace name";
        case Error::ExpectedAliasName: return "expected type alias name";
        case Error::ExpectedAliasAssign: return "expected '=' after type alias name";
        case Error::ExpectedAliasSemicolon: return "expected ';' after type alias";
        case Error::ExpectedGlobalName: return "expected global declaration name";
        case Error::ExpectedGlobalInitializer: return "expected '=' before global scalar initializer";
        case Error::ExpectedGlobalSemicolon: return "expected ';' after global declaration";
        case Error::ExpectedArrayClose: return "expected ']' after static array length";
        case Error::ArrayInitializer: return "static arrays initialize to zero and cannot have an initializer";
        default: return "unknown function-file error";
    }
}
