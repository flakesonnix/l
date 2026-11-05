/* Standard stream I/O: the four fixed VM intrinsics. */
module std.io;

/* Reads one byte from standard input (0..255, or -1 at end of input). */
pub extern int read_byte();

/* Writes one raw byte to standard output. */
pub extern void write_byte(byte value);

/* Writes the raw bytes of a string to standard output. */
pub extern void write_string(string value);

/* Writes the raw bytes of a string to standard error. */
pub extern void write_error(string value);
