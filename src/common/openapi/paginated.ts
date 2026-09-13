import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export class PageMeta {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 37 })
  total: number;
}

/** Documents `{ data: Model[], page, limit, total }` as the 200 response. */
export function ApiPaginatedResponse<TModel extends Type<unknown>>(model: TModel, description?: string) {
  return applyDecorators(
    ApiExtraModels(PageMeta, model),
    ApiOkResponse({
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(PageMeta) },
          { type: 'object', required: ['data'], properties: { data: { type: 'array', items: { $ref: getSchemaPath(model) } } } },
        ],
      },
    }),
  );
}
