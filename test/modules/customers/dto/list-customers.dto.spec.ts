import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListCustomersDto } from '@/modules/customers/dto/list-customers.dto';

describe('ListCustomersDto', () => {
  it('treats an empty search as absent (no validation error)', () => {
    const dto = plainToInstance(ListCustomersDto, { search: '' });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.search).toBeUndefined();
  });

  it('still rejects a search longer than 100 chars', () => {
    const dto = plainToInstance(ListCustomersDto, { search: 'a'.repeat(101) });
    expect(validateSync(dto)).toHaveLength(1);
  });
});
