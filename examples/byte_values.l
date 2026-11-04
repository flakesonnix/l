module examples.byte_values;

pub using Octet = byte;

pub struct Pair {
    Octet first;
    Octet second;
};

pub byte sum(Pair pair) {
    return byte(int(pair.first) + int(pair.second));
}
