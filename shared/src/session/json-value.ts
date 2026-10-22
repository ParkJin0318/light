/**
 * 세션 통신의 임의 JSON — 도구 입력(`input`)은 받은 모양 그대로 되돌려 보내야 한다
 * (`can_use_tool` 허용 응답의 `updatedInput`).
 *
 * `JSON.parse` 가 준 값을 그대로 쓴다. 없는 키는 `undefined`, JSON `null` 은 `null` 이다 — 둘은 다르다
 */
export type JSONValue = null | boolean | number | string | JSONValue[] | JSONObject;
export type JSONObject = { [key: string]: JSONValue };

/** 조각 값(숫자·문자열 하나)도 받는다. 못 읽으면 undefined */
export function parseJSON(line: string): JSONValue | undefined {
  try {
    return JSON.parse(line) as JSONValue;
  } catch {
    return undefined;
  }
}

/** 중첩 키 읽기 — 객체가 아니거나 키가 없으면 undefined */
export function jget(json: JSONValue | undefined, ...path: string[]): JSONValue | undefined {
  let current: JSONValue | undefined = json;
  for (const key of path) {
    if (current === undefined || current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    // 프로토타입 키("constructor" 등)가 값으로 읽히지 않게
    if (!Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

export function jstr(json: JSONValue | undefined): string | undefined {
  return typeof json === "string" ? json : undefined;
}

export function jnum(json: JSONValue | undefined): number | undefined {
  return typeof json === "number" ? json : undefined;
}

/** 정수로 — 0 쪽으로 버린다 */
export function jint(json: JSONValue | undefined): number | undefined {
  return typeof json === "number" ? Math.trunc(json) : undefined;
}

export function jbool(json: JSONValue | undefined): boolean | undefined {
  return typeof json === "boolean" ? json : undefined;
}

export function jarr(json: JSONValue | undefined): JSONValue[] | undefined {
  return Array.isArray(json) ? json : undefined;
}

export function jstrings(json: JSONValue | undefined): string[] {
  return (jarr(json) ?? []).flatMap((value) => (typeof value === "string" ? [value] : []));
}

export function jobj(json: JSONValue | undefined): JSONObject | undefined {
  return json !== undefined && json !== null && typeof json === "object" && !Array.isArray(json) ? json : undefined;
}
