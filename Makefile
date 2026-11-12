CC = cc
CPPFLAGS =
CFLAGS = -std=c11 -O2 -g -Wall -Wextra -Wpedantic -Werror
LDFLAGS =

SOURCES = bootstrap/stage0/common.c bootstrap/stage0/config.c \
          bootstrap/stage0/constants.c bootstrap/stage0/modules.c \
          bootstrap/stage0/lexer.c bootstrap/stage0/parser.c bootstrap/stage0/semantic.c \
          bootstrap/stage0/lir.c bootstrap/stage0/bytecode.c \
          bootstrap/stage0/vm.c bootstrap/stage0/main.c

.PHONY: all stage1 test fuzz coverage sanitize clean
all: build/l

build/l: $(SOURCES) bootstrap/stage0/l.h
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SOURCES) $(LDFLAGS) -o $@

stage1: build/stage1-lexer.lbc build/stage1-expression.lbc build/stage1-statement.lbc build/stage1-header.lbc build/stage1-function.lbc build/stage1-binding.lbc

build/stage1-lexer.lbc: build/l bootstrap/stage1/lexer.l bootstrap/stage1/main.l bootstrap/stage1/package.json stdlib/io.l
	./build/l compile bootstrap/stage1/main.l --manifest bootstrap/stage1/package.json -o $@

build/stage1-expression.lbc: build/l bootstrap/stage1/lexer.l bootstrap/stage1/expressions.l bootstrap/stage1/expression_main.l bootstrap/stage1/package.json stdlib/io.l
	./build/l compile bootstrap/stage1/expression_main.l --manifest bootstrap/stage1/package.json -o $@

build/stage1-statement.lbc: build/l bootstrap/stage1/lexer.l bootstrap/stage1/expressions.l bootstrap/stage1/statements.l bootstrap/stage1/statement_main.l bootstrap/stage1/package.json stdlib/io.l
	./build/l compile bootstrap/stage1/statement_main.l --manifest bootstrap/stage1/package.json -o $@

build/stage1-header.lbc: build/l bootstrap/stage1/lexer.l bootstrap/stage1/expressions.l bootstrap/stage1/headers.l bootstrap/stage1/header_main.l bootstrap/stage1/package.json stdlib/io.l
	./build/l compile bootstrap/stage1/header_main.l --manifest bootstrap/stage1/package.json -o $@

build/stage1-function.lbc: build/l bootstrap/stage1/lexer.l bootstrap/stage1/expressions.l bootstrap/stage1/statements.l bootstrap/stage1/headers.l bootstrap/stage1/functions.l bootstrap/stage1/function_main.l bootstrap/stage1/package.json stdlib/io.l
	./build/l compile bootstrap/stage1/function_main.l --manifest bootstrap/stage1/package.json -o $@

build/stage1-binding.lbc: build/l bootstrap/stage1/lexer.l bootstrap/stage1/expressions.l bootstrap/stage1/headers.l bootstrap/stage1/bindings.l bootstrap/stage1/binding_main.l bootstrap/stage1/package.json stdlib/io.l
	./build/l compile bootstrap/stage1/binding_main.l --manifest bootstrap/stage1/package.json -o $@

test: build/l
	sh tests/run.sh ./build/l
	node tests/modules.mjs ./build/l
	node tests/stage1.mjs ./build/l
	node tests/stage1-expressions.mjs ./build/l
	node tests/stage1-statements.mjs ./build/l
	node tests/stage1-headers.mjs ./build/l
	node tests/stage1-functions.mjs ./build/l
	node tests/stage1-bindings.mjs ./build/l
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/frontend.c $(LDFLAGS) -o build/frontend-test
	./build/frontend-test
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/faults.c $(LDFLAGS) -Wl,--wrap=calloc,--wrap=fread,--wrap=ferror,--wrap=fclose,--wrap=stat -o build/faults-test
	./build/faults-test
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/verifier.c $(LDFLAGS) -o build/verifier-test
	./build/verifier-test
	$(CC) $(CPPFLAGS) $(CFLAGS) -DL_NO_MAIN $(SOURCES) tests/observer.c $(LDFLAGS) -o build/observer-test
	./build/observer-test
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
	rm -f build/l build/stage1-lexer.lbc build/stage1-expression.lbc build/stage1-statement.lbc build/stage1-header.lbc build/stage1-function.lbc build/stage1-binding.lbc
