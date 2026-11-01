.PHONY: install dev test verify build
install:
	npm ci
dev:
	npm run dev
test:
	npm run test:coverage
build:
	npm run build
verify: build test
	npm run typecheck
