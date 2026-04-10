import { parseArticleJsonResponse } from '../src/services/article-json-parser';

describe('parseArticleJsonResponse', () => {
  test('parses markdown-fenced json', () => {
    const input = '```json\n{"title":"My Title","conclusion":"done"}\n```';
    const out = parseArticleJsonResponse<{ title: string }>(input);
    expect(out.title).toBe('My Title');
  });

  test('parses json with surrounding prose', () => {
    const input = 'Here is the result:\n{"title":"Another","sections":[]}\nThanks';
    const out = parseArticleJsonResponse<{ title: string }>(input);
    expect(out.title).toBe('Another');
  });

  test('throws when no json object exists', () => {
    expect(() => parseArticleJsonResponse('no json here')).toThrow('No article JSON in model response');
  });

  test('parses when title field is missing', () => {
    const out = parseArticleJsonResponse<{ metaDescription: string }>('{"metaDescription":"x"}');
    expect(out.metaDescription).toBe('x');
  });
});
