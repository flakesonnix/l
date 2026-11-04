module examples.enum_demo;

import examples.token_kinds::{Kind as K, Token, evaluate};

const K initial = K::Identifier;
static K current = initial;

int main() {
    Token token = Token{K::Number, 42};
    current = token.kind;
    if (current == K::Number) return evaluate(token);
    return 0;
}
