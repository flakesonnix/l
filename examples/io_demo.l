/* Echo raw input to stdout, keeping diagnostics on stderr. */
module examples.io_demo;

import std.io as io;

int main() {
    io::write_string("Echo: ");
    for (;;) {
        int value = io::read_byte();
        if (value == -1) break;
        io::write_byte(byte(value));
    }
    io::write_error("Input copied.\n");
    return 0;
}
