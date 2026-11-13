// First replacement-grammar file slice. Parses syntax; never runs input.
module l.compiler.bindings;

import l.compiler.lexer as lexer;
import l.compiler.expressions as expressions;
import l.compiler.headers as headers;
import l.compiler.statements as statements;

pub const int max_nodes = 1024;
pub const int max_functions = 256;
pub const int max_records = 256;
pub const int max_enums = 256;
pub const int max_fields = 64;
namespace kind {
    pub const int Invalid = 0;
    pub const int Module = 1;
    pub const int Constant = 2;
    pub const int Function = 3;
    pub const int Parameter = 4;
    pub const int Record = 5;
    pub const int Field = 6;
    pub const int Alias = 7;
    pub const int Namespace = 8;
    pub const int Enum = 9;
    pub const int Member = 10;
    pub const int Struct = 11;
    pub const int Static = 12;
}
pub enum Error { None, Header, Statement, Expression, ExpectedName, ExpectedAssign,
                 ExpectedOpen, ExpectedClose, ExpectedColon, ExpectedBody, ExpectedBinding,
                 ExpectedSemicolon, MisplacedHeader, TooManyNodes, TooManyFunctions,
                 ExpectedRecordOpen, ExpectedRecordClose, ExpectedFieldName, TooManyRecords, TooManyFields,
                 ExpectedNamespaceOpen, ExpectedNamespaceClose, NamespaceVisibility,
                 ExpectedEnumOpen, ExpectedEnumName, ExpectedEnumClose, TooManyEnums,
                 ExpectedStructName, ExpectedStructOpen, ExpectedStructFieldName, ExpectedStructFieldSemicolon, ExpectedStructClose,
                 ExpectedStaticName, ExpectedStaticInitializer, ExpectedStaticSemicolon,
                 ExpectedArrayClose, ArrayInitializer, ExpectedExternSemicolon };
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
    int name_start;
    int name_length;
    bool exported;
    int header;
    int type;
    int items;
    int body;
    int next;
    bool immutable; // Written const on a parameter; false for other declarations.
    bool external; // Written extern on a function; false for other declarations.
    int array; // Expression-arena length for a static array; absent otherwise.
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
static bool immutables[max_nodes];
static bool externals[max_nodes];
static int arrays[max_nodes];
static int used = 0;
static int function_count = 0;
static int record_count = 0;
static int enum_count = 0;
static Error failure = Error::None;
static headers::Error header_failure = headers::Error::None;
static statements::Error statement_failure = statements::Error::None;
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
        return false;
    }
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
    immutables[id] = false;
    externals[id] = false;
    arrays[id] = -1;
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
    lexer::Token start = current();
    bool immutable = take(lexer::Kind::Const);
    int declared = type();
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedName);
    int result = make_node(kind::Parameter, start);
    if (result != -1) {
        name_starts[result] = name.start;
        name_lengths[result] = name.length;
        types[result] = declared;
        immutables[result] = immutable;
    }
    return result;
}
int function(lexer::Token start, bool exported, int declared, bool external) {
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedName);
    expect(lexer::Kind::LeftParen, Error::ExpectedOpen);
    if (ok() && function_count == max_functions) reject(Error::TooManyFunctions, start);
    if (!ok()) return -1;
    function_count++;
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
    if (external) expect(lexer::Kind::Semicolon, Error::ExpectedExternSemicolon);
    else {
        if (ok() && current().kind != lexer::Kind::LeftBrace) reject(Error::ExpectedBody, current());
        if (ok()) { body = statements::parse_next(); ok(); }
    }
    if (!ok()) return -1;
    types[result] = declared;
    items[result] = first;
    bodies[result] = body;
    name_starts[result] = name.start;
    name_lengths[result] = name.length;
    exports[result] = exported;
    externals[result] = external;
    return result;
}
int static_declaration(lexer::Token start, bool exported) {
    int declared = type();
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedStaticName);
    int length = -1;
    int initial = -1;
    if (take(lexer::Kind::LeftBracket)) {
        length = value();
        expect(lexer::Kind::RightBracket, Error::ExpectedArrayClose);
        if (ok() && current().kind == lexer::Kind::Assign) reject(Error::ArrayInitializer, current());
    } else {
        expect(lexer::Kind::Assign, Error::ExpectedStaticInitializer);
        initial = value();
    }
    expect(lexer::Kind::Semicolon, Error::ExpectedStaticSemicolon);
    int result = make_node(kind::Static, start);
    if (result != -1) {
        types[result] = declared;
        name_starts[result] = name.start;
        name_lengths[result] = name.length;
        exports[result] = exported;
        bodies[result] = initial;
        arrays[result] = length;
    }
    return result;
}
int record_declaration(lexer::Token start) {
    expect(lexer::Kind::LeftBrace, Error::ExpectedRecordOpen);
    if (ok() && record_count == max_records) reject(Error::TooManyRecords, start);
    if (!ok()) return -1;
    record_count++;
    int result = make_node(kind::Record, start);
    int count = 0;
    int last = -1;
    while (ok() && !take(lexer::Kind::RightBrace)) {
        if (current().kind == lexer::Kind::End) { reject(Error::ExpectedRecordClose, current()); break; }
        if (count == max_fields) { reject(Error::TooManyFields, current()); break; }
        lexer::Token name = current();
        expect(lexer::Kind::Name, Error::ExpectedFieldName);
        expect(lexer::Kind::Colon, Error::ExpectedColon);
        int declared = type();
        expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
        int item = make_node(kind::Field, name);
        if (!ok()) break;
        name_starts[item] = name.start;
        name_lengths[item] = name.length;
        types[item] = declared;
        if (last == -1) items[result] = item;
        else nexts[last] = item;
        last = item;
        count++;
    }
    expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
    if (!ok()) return -1;
    return result;
}
int enum_declaration(lexer::Token start) {
    expect(lexer::Kind::LeftBrace, Error::ExpectedEnumOpen);
    if (ok() && enum_count == max_enums) reject(Error::TooManyEnums, start);
    if (!ok()) return -1;
    enum_count++;
    int result = make_node(kind::Enum, start);
    int last = -1;
    while (ok() && !take(lexer::Kind::RightBrace)) {
        if (current().kind == lexer::Kind::End) { reject(Error::ExpectedEnumClose, current()); break; }
        lexer::Token name = current();
        expect(lexer::Kind::Name, Error::ExpectedEnumName);
        if (!ok()) break;
        int item = make_node(kind::Member, name);
        if (!ok()) break;
        if (item != -1) { name_starts[item] = name.start; name_lengths[item] = name.length; }
        if (take(lexer::Kind::Assign)) {
            int initial = value();
            if (!ok()) break;
            if (item != -1) bodies[item] = initial;
        }
        expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
        if (!ok()) break;
        if (last == -1) items[result] = item;
        else nexts[last] = item;
        last = item;
    }
    expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
    if (!ok()) return -1;
    return result;
}
int struct_declaration(lexer::Token start, bool exported) {
    take(lexer::Kind::Struct);
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedStructName);
    if (!ok()) return -1;
    expect(lexer::Kind::LeftBrace, Error::ExpectedStructOpen);
    if (ok() && record_count == max_records) reject(Error::TooManyRecords, start);
    if (!ok()) return -1;
    record_count++;
    int result = make_node(kind::Struct, start);
    int count = 0;
    int last = -1;
    while (ok() && !take(lexer::Kind::RightBrace)) {
        if (current().kind == lexer::Kind::End) { reject(Error::ExpectedStructClose, current()); break; }
        if (count == max_fields) { reject(Error::TooManyFields, current()); break; }
        int declared = type();
        if (!ok()) break;
        lexer::Token name = current();
        expect(lexer::Kind::Name, Error::ExpectedStructFieldName);
        if (!ok()) break;
        expect(lexer::Kind::Semicolon, Error::ExpectedStructFieldSemicolon);
        if (!ok()) break;
        int item = make_node(kind::Field, name);
        if (!ok()) break;
        if (item != -1) {
            name_starts[item] = name.start;
            name_lengths[item] = name.length;
            types[item] = declared;
        }
        if (last == -1) items[result] = item;
        else nexts[last] = item;
        last = item;
        count++;
    }
    expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
    if (!ok()) return -1;
    name_starts[result] = name.start;
    name_lengths[result] = name.length;
    exports[result] = exported;
    return result;
}
int namespace_declaration(lexer::Token start) {
    if (!expressions::enter()) { ok(); return -1; }
    take(lexer::Kind::Namespace);
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
    expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
    if (!ok()) return -1;
    return result;
}
int declaration() {
    lexer::Token start = current();
    if (start.kind == lexer::Kind::Module || start.kind == lexer::Kind::Import) {
        reject(Error::MisplacedHeader, start);
        return -1;
    }
    bool exported = take(lexer::Kind::Pub);
    if (take(lexer::Kind::Static)) return static_declaration(start, exported);
    if (take(lexer::Kind::Extern)) {
        int declared = type();
        return function(start, exported, declared, true);
    }
    if (ok() && statements::primitive(current().kind) != statements::type_kind::Invalid) {
        int declared = type();
        return function(start, exported, declared, false);
    }
    if (ok() && current().kind == lexer::Kind::Struct) return struct_declaration(start, exported);
    lexer::Token name = current();
    expect(lexer::Kind::Name, Error::ExpectedName);
    if (!ok()) return -1;
    if (current().kind != lexer::Kind::Colon && current().kind != lexer::Kind::Assign) {
        int declared = expressions::parse_type_from_name(name);
        ok();
        return function(start, exported, declared, false);
    }
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
        if (take(lexer::Kind::Record)) result = record_declaration(start);
        else if (take(lexer::Kind::Enum)) result = enum_declaration(start);
        else if (take(lexer::Kind::Alias)) {
            int declared = type();
            expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
            result = make_node(kind::Alias, start);
            if (result != -1) types[result] = declared;
        } else if (ok() && current().kind == lexer::Kind::Namespace) {
            if (exported) reject(Error::NamespaceVisibility, start);
            else result = namespace_declaration(start);
        } else {
            if (ok()) reject(Error::ExpectedBinding, current());
        }
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
    record_count = 0;
    enum_count = 0;
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
        statements::discard();
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
    if (!ok()) { used = 0; function_count = 0; record_count = 0; enum_count = 0; headers::discard(); statements::discard(); return -1; }
    header_ids[root] = header;
    return root;
}
pub int node_count() { return used; }
pub Node node(int id) {
    if (id < 0 || id >= used) return Node{kind::Invalid, 0, 0, 0, 0, 0, 0, false, -1, -1, -1, -1, -1, false, false, -1};
    return Node{kinds[id], starts[id], lengths[id], lines[id], columns[id], name_starts[id], name_lengths[id],
        exports[id], header_ids[id], types[id], items[id], bodies[id], nexts[id], immutables[id], externals[id], arrays[id]};
}
pub Diagnostic diagnostic() {
    return Diagnostic{failure, header_failure, statement_failure, expression_failure, lexical_failure,
        failure_start, failure_length, failure_line, failure_column};
}
pub string error_message(Error error) {
    switch (error) {
        case Error::None: return "no binding-file error";
        case Error::Header: return "module/import header error";
        case Error::Expression: return "expression error";
        case Error::Statement: return "statement error";
        case Error::ExpectedName: return "expected binding or parameter name";
        case Error::ExpectedAssign: return "expected '=' after binding name/type";
        case Error::ExpectedOpen: return "expected '(' after function name";
        case Error::ExpectedClose: return "expected ')' after parameters";
        case Error::ExpectedColon: return "expected ':' before written type";
        case Error::ExpectedBody: return "expected function block body";
        case Error::ExpectedBinding: return "expected record, enum, alias or namespace after binding '='";
        case Error::ExpectedSemicolon: return "expected ';' after binding";
        case Error::MisplacedHeader: return "module and import declarations must precede bindings";
        case Error::TooManyNodes: return "binding file exceeds 1024 declaration nodes";
        case Error::TooManyFunctions: return "binding file exceeds 256 functions";
        case Error::ExpectedRecordOpen: return "expected '{' after record";
        case Error::ExpectedRecordClose: return "expected '}' after record fields";
        case Error::ExpectedFieldName: return "expected record field name";
        case Error::TooManyRecords: return "binding file exceeds 256 record/struct declarations";
        case Error::TooManyFields: return "record exceeds 64 fields";
        case Error::ExpectedNamespaceOpen: return "expected '{' after namespace";
        case Error::ExpectedNamespaceClose: return "expected '}' after namespace declarations";
        case Error::NamespaceVisibility: return "namespace bindings cannot use pub; export their members individually";
        case Error::ExpectedEnumOpen: return "expected '{' after enum";
        case Error::ExpectedEnumName: return "expected enum member name";
        case Error::ExpectedEnumClose: return "expected '}' after enum members";
        case Error::TooManyEnums: return "binding file exceeds 256 enums";
        case Error::ExpectedStructName: return "expected struct name";
        case Error::ExpectedStructOpen: return "expected '{' after struct name";
        case Error::ExpectedStructFieldName: return "expected struct field name";
        case Error::ExpectedStructFieldSemicolon: return "expected ';' after scalar struct field";
        case Error::ExpectedStructClose: return "expected '}' after struct fields";
        case Error::ExpectedStaticName: return "expected static storage name";
        case Error::ExpectedStaticInitializer: return "static storage requires a scalar initializer";
        case Error::ExpectedStaticSemicolon: return "expected ';' after static declaration";
        case Error::ExpectedArrayClose: return "expected ']' after static array length";
        case Error::ArrayInitializer: return "static arrays initialize to zero and cannot have an initializer";
        case Error::ExpectedExternSemicolon: return "expected ';' after extern declaration";
        default: return "unknown binding-file error";
    }
}
