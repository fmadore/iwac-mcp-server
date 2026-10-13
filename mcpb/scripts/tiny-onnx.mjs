// A one-node ONNX model (y = Identity(x), float32[2]) encoded by hand, so the
// packaged onnxruntime can be made to create and run a real session without
// shipping or downloading a model file. Protobuf field numbers follow onnx.proto.

/** @param {number} n */
function varint(n) {
  const out = [];
  for (; n > 0x7f; n >>>= 7) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return out;
}
/** Field `number` holding a varint. */
const int = (number, value) => [...varint((number << 3) | 0), ...varint(value)];
/** Field `number` holding bytes: a string or an already-encoded message. */
function bytes(number, value) {
  const body = typeof value === "string" ? [...Buffer.from(value, "utf8")] : value;
  return [...varint((number << 3) | 2), ...varint(body.length), ...body];
}

function valueInfo(name) {
  const shape = bytes(2, bytes(1, int(1, 2))); // TensorShapeProto { dim { dim_value: 2 } }
  const tensor = bytes(1, [...int(1, 1), ...shape]); // TypeProto.tensor_type { elem_type: FLOAT, shape }
  return [...bytes(1, name), ...bytes(2, tensor)];
}

export function tinyOnnxModel() {
  const node = [...bytes(1, "x"), ...bytes(2, "y"), ...bytes(4, "Identity")];
  const graph = [...bytes(1, node), ...bytes(2, "identity"), ...bytes(11, valueInfo("x")), ...bytes(12, valueInfo("y"))];
  const model = [...int(1, 8), ...bytes(8, int(2, 13)), ...bytes(7, graph)];
  return Uint8Array.from(model);
}
