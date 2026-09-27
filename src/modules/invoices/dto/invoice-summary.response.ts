import { ApiProperty } from '@nestjs/swagger';

class PeriodTotals {
  @ApiProperty({ example: 12, description: 'Notas ISSUED no período' }) count: number;
  @ApiProperty({ example: '4350.00', description: 'Soma dos valores das notas ISSUED (string decimal)' }) total: string;
  @ApiProperty({ format: 'date-time', description: 'Início do período (fuso America/Sao_Paulo)' }) start: string;
}
class StatusCounts {
  @ApiProperty({ example: 0 }) PENDING: number;
  @ApiProperty({ example: 40 }) ISSUED: number;
  @ApiProperty({ example: 2 }) REJECTED: number;
  @ApiProperty({ example: 3 }) CANCELLED: number;
}

export class InvoiceSummaryResponseModel {
  @ApiProperty({ type: PeriodTotals }) month: PeriodTotals;
  @ApiProperty({ type: PeriodTotals }) year: PeriodTotals;
  @ApiProperty({ type: StatusCounts, description: 'Contagem de todas as notas da empresa por status' }) byStatus: StatusCounts;
  @ApiProperty({ example: '81000.00', description: 'Teto anual de faturamento do MEI (MEI_ANNUAL_LIMIT)' }) annualLimit: string;
  @ApiProperty({ example: 5.4, description: 'year.total / annualLimit em %, 1 casa decimal' }) annualUsagePct: number;
}
