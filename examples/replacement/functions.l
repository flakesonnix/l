module app.functions;

pub add : int -> int -> int;
add = a: b: a + b;

twice : int -> int;
twice = value: do {
    int total = 0;
    for (int i = 0; i < 2; i++) {
        total = add total value;
    }
    return total;
};

main : () -> int;
main = twice 21;
