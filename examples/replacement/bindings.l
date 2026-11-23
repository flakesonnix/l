module app.bindings;

sum : int -> int;
sum = count: do {
    var total = 0;
    for (var i = 0; i < count; i++) {
        total = total + i;
    }
    return total;
};

main : () -> int;
main = do {
    var value = sum 7;
    value = value + 21;
    return value;
};
