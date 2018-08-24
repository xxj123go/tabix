// import { None, Option, Some } from 'funfix-core';
import { RequestableStore, LocalUIStore } from '@vzh/mobx-stores';
// import { ErrorResponse } from 'shared/types';
import RootStore from './RootStore';

export default class ApiRequestableStore extends RequestableStore<
  RootStore,
  LocalUIStore<RootStore>
> {
  // protected isErrorResponse(data: ErrorResponse | any): data is ErrorResponse {
  //   return data && data.error !== undefined;
  // }

  // protected getResponseErrorMessage(response: AxiosResponse): string {
  //   console.log(response.data);

  //   return Option.of(response.data)
  //     .flatMap(data => (this.isErrorResponse(data) ? Some(data) : None))
  //     .map(
  //       d =>
  //         `${d.message}${Option.of(d.hint)
  //           .map(s => `\n${s}`)
  //           .getOrElse('')}`
  //     )
  //     .getOrElse(response.statusText);
  // }
}