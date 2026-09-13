import { ApiProperty } from '@nestjs/swagger';

export class CustomerResponseModel {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: '11444777000161', description: 'CPF (11) or CNPJ (14), digits only' }) documento: string;
  @ApiProperty({ example: 'Empresa Cliente' }) nome: string;
  @ApiProperty({ nullable: true, example: 'fin@cliente.com' }) email: string | null;
  @ApiProperty({ nullable: true, example: '11999999999' }) telefone: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}
