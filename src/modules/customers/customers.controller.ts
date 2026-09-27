import { ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '../../common/openapi/common-responses';
import { ErrorResponse } from '../../common/openapi/error.response';
import { ApiPaginatedResponse } from '../../common/openapi/paginated';
import { CustomerResponseModel } from './dto/customer.response';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AllowExpiredTrial } from '../companies/allow-expired-trial.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@ApiTags('customers')
@ApiBearerAuth('logto')
@ApiCommonErrors()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @ApiOperation({ summary: 'Cria um tomador salvo' })
  @ApiCreatedResponse({ type: CustomerResponseModel })
  @ApiConflictResponse({ type: ErrorResponse, description: 'Documento já cadastrado na empresa' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista tomadores (search por nome ou início do documento)' })
  @ApiPaginatedResponse(CustomerResponseModel)
  @AllowExpiredTrial()
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListCustomersDto) {
    return this.customers.findAll(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe do tomador' })
  @ApiOkResponse({ type: CustomerResponseModel })
  @AllowExpiredTrial()
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOne(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um tomador' })
  @ApiOkResponse({ type: CustomerResponseModel })
  @ApiConflictResponse({ type: ErrorResponse })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(user.id, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove um tomador (notas antigas mantêm a cópia dos dados)' })
  @ApiNoContentResponse()
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(user.id, id);
  }
}
