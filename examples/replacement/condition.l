module app.condition;

countdown : int -> int;
countdown = start: do {
    var n = start;
    var steps = 0;
    while (n > 0): do {
        n = n - 1;
        steps++;
    }
    return steps;
};

main : () -> int;
main = do {
    var steps = countdown 7;
    return steps + 35;
};
