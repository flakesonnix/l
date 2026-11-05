/* Shared source storage without pointers: read stdin, then emit its bytes in reverse. */
module examples.static_buffers;

import std.io as io;

const int capacity = 65535;
static byte source[capacity];
static int length = 0;

bool read_source() {
    while (length < capacity) {
        int value = io::read_byte();
        if (value == -1) return true;
        source[length++] = byte(value);
    }
    return io::read_byte() == -1;
}

void write_reverse() {
    for (int n = length; n > 0; n--) io::write_byte(source[n - 1]);
}

int main() {
    if (!read_source()) {
        io::write_error("Input exceeds the 65535-byte source buffer.\n");
        return 1;
    }
    write_reverse();
    return 0;
}
