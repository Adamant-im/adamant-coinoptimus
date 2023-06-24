function validate(config, schema, parentKey = '') {
  for (const [key, value] of Object.entries(schema)) {
    const fieldName = parentKey ? `${parentKey}.${key}` : key;

    if (config[key] === undefined) {
      if (value.isRequired) {
        throw new Error(`Field _${fieldName}_ is required.`);
      } else if (value.default !== undefined) {
        config[key] = value.default;
      }

      continue;
    }

    if (Array.isArray(value.type)) {
      validateArray(config[key], value.type, fieldName);
      continue;
    }

    if (typeof value.type === 'object') {
      validateObject(config[key], value.type, fieldName);
      continue;
    }

    if (config[key] !== false && value.type !== config[key].constructor) {
      throw new Error(`Field _${fieldName}_ is not valid, expected type is _${value.type.name}_.`);
    }
  }
}

function validateArray(array, type, fieldName) {
  if (!Array.isArray(array)) {
    throw new Error(`Field _${fieldName}_ is not valid, expected an array.`);
  }

  const isValidArray = array.every((item) => type.includes(item.constructor));

  if (!isValidArray) {
    throw new Error(`Field _${fieldName}_ items are not valid.`);
  }
}

function validateObject(object, schema, fieldName) {
  if (typeof object !== 'object') {
    throw new Error(`Field _${fieldName}_ is not valid, expected an object.`);
  }

  validate(object, schema, fieldName);
}

module.exports = validate;
