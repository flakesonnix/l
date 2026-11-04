CC = cc
CPPFLAGS =
CFLAGS = -std=c11 -O2 -g -Wall -Wextra -Wpedantic -Werror
LDFLAGS =

SOURCES = bootstrap/stage0/common.c bootstrap/stage0/config.c \
          bootstrap/stage0/constants.c bootstrap/stage0/modules.c \
          bootstrap/stage0/lexer.c bootstrap/stage0/parser.c bootstrap/stage0/semantic.c \
          bootstrap/stage0/lir.c bootstrap/stage0/bytecode.c \
          bootstrap/stage0/vm.c bootstrap/stage0/main.c

.PHONY: all test fuzz coverage sanitize clean
all: build/l

build/l: $(SOURCES) bootstrap/stage0/l.h
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SOURCES) $(LDFLAGS) -o $@

test: build/l
	sh tests/run.sh ./build/l
	node tests/modules.mjs ./build/l
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/frontend.c $(LDFLAGS) -o build/frontend-test
	./build/frontend-test
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/faults.c $(LDFLAGS) -Wl,--wrap=calloc,--wrap=fread,--wrap=ferror,--wrap=fclose -o build/faults-test
	./build/faults-test
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/verifier.c $(LDFLAGS) -o build/verifier-test
	./build/verifier-test
	$(MAKE) fuzz

fuzz:
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/fuzz.c $(LDFLAGS) -o build/fuzz-test
	./build/fuzz-test

sanitize:
	$(MAKE) clean
	$(MAKE) CFLAGS='-std=c11 -O1 -g -Wall -Wextra -Wpedantic -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie' LDFLAGS='-fsanitize=address,undefined -no-pie' test

coverage:
	CC='$(CC)' node tests/coverage.mjs

clean:
	rm -f build/l
