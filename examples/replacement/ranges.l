module app.ranges;

sum : int -> int;
sum = count: do {
    var total = 0;
    for i in 0..count: do {
        total = total + i;
    }
    return total;
};

main : () -> int;
main = do {
    var total = sum 7;
    total = total + 21;
    return total;
};
