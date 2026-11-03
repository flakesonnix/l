CC = cc
CPPFLAGS =
CFLAGS = -std=c11 -O2 -g -Wall -Wextra -Wpedantic -Werror
LDFLAGS =

SOURCES = bootstrap/stage0/common.c bootstrap/stage0/lexer.c \
          bootstrap/stage0/parser.c bootstrap/stage0/semantic.c \
          bootstrap/stage0/lir.c bootstrap/stage0/bytecode.c \
          bootstrap/stage0/vm.c bootstrap/stage0/main.c

.PHONY: all test sanitize clean
all: build/l

build/l: $(SOURCES) bootstrap/stage0/l.h
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SOURCES) $(LDFLAGS) -o $@

test: build/l
	sh tests/run.sh ./build/l
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/frontend.c $(LDFLAGS) -o build/frontend-test
	./build/frontend-test

sanitize:
	$(MAKE) clean
	$(MAKE) CFLAGS='-std=c11 -O1 -g -Wall -Wextra -Wpedantic -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie' LDFLAGS='-fsanitize=address,undefined -no-pie' test

clean:
	rm -f build/l
